import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  CloudIngestionProvider,
  CloudIngestionResult,
  NormalizedCloudResource,
  NormalizedFocusCostLineItem,
  NormalizedResourceMetricSample,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { parseFocusCsvStream, toAsyncByteChunks } from './focusCsvIngestion.js';
import {
  getCredential,
  optionalString,
  readBoundedPositiveInteger,
  readObjectArray,
  readStringArray,
  requireString,
} from './providerConfig.js';

interface AwsMetricDefinition {
  readonly externalResourceId: string;
  readonly namespace: string;
  readonly metricName: string;
  readonly dimensions: readonly { readonly Name: string; readonly Value: string }[];
  readonly stat: string;
  readonly unit?: string;
  readonly region?: string;
}

interface AwsFocusExportObject {
  readonly bucket: string;
  readonly key: string;
  readonly region?: string;
  readonly focusVersion: string;
}

interface AwsFocusExportLocation {
  readonly bucket: string;
  readonly prefix: string;
  readonly region?: string;
  readonly focusVersion: string;
  readonly maxObjects: number;
}

interface AwsCommandClient<TResponse> {
  send(command: unknown): Promise<TResponse>;
}

interface AwsAssumeRoleResponse {
  readonly Credentials?: {
    readonly AccessKeyId?: string;
    readonly SecretAccessKey?: string;
    readonly SessionToken?: string;
  };
}

interface AwsMetricDataResponse {
  readonly MetricDataResults?: readonly {
    readonly Id?: string;
    readonly Timestamps?: readonly Date[];
    readonly Values?: readonly number[];
  }[];
}

interface AwsGetObjectResponse {
  readonly Body?: unknown;
}

interface AwsListObjectsResponse {
readonly Contents?: readonly {
readonly Key?: string;
}[];
readonly IsTruncated?: boolean;
readonly NextContinuationToken?: string;
}

interface AwsDescribeInstancesResponse {
readonly Reservations?: readonly {
readonly Instances?: readonly AwsEc2Instance[];
}[];
readonly NextToken?: string;
}

interface AwsEc2Instance {
readonly InstanceId?: string;
readonly InstanceType?: string;
readonly State?: { readonly Name?: string };
readonly Placement?: { readonly AvailabilityZone?: string };
readonly Tags?: readonly { readonly Key?: string; readonly Value?: string }[];
}

export class AwsSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'aws';

  public async collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    if (job.sourceType === 'BILLING_EXPORT') {
      return this.collectBillingExport(job);
    }

if (job.sourceType === 'INVENTORY') {
const inventory = await this.collectInventoryResources(job);
return {
apiCallCount: inventory.apiCallCount,
objectsProcessed: inventory.resources.length,
focusRows: [],
resources: inventory.resources,
metricSamples: [],
warnings: inventory.warnings,
coverage: {
inventorySource: inventory.source,
inventoryImplemented: true,
resources: inventory.resources.length,
},
};
}

    if (job.sourceType !== 'TECHNICAL_METRIC') {
      return this.emptyResult(0, [`Unsupported AWS ingestion source ${job.sourceType}`], {});
    }

    const definitions = this.readMetricDefinitions(job);
    if (definitions.length === 0) {
      return this.emptyResult(0, [
        'No AWS CloudWatch metric definitions configured in cloud connection metadata key awsMetricDefinitions.',
      ], {
        metricDefinitions: 0,
      });
    }

    const credential = getCredential(job.connection.credentials, ['METRICS_READ', 'OPERATIONAL']);
    if (credential === undefined) {
      throw new Error('AWS METRICS_READ or OPERATIONAL credential is required');
    }

    const baseRegion = job.connection.defaultRegion ?? 'us-east-1';
    const assumed = await this.assumeRole(credential, baseRegion);
    const samples: NormalizedResourceMetricSample[] = [];
    let apiCallCount = 1;

    for (const [region, regionDefinitions] of this.groupByRegion(definitions, baseRegion)) {
      const client = this.createCloudWatchClient(region, assumed);

      for (const batch of this.chunk(regionDefinitions, 500)) {
        apiCallCount += 1;
        const response = await client.send(new GetMetricDataCommand({
          StartTime: job.targetStart,
          EndTime: job.targetEnd,
          ScanBy: 'TimestampAscending',
          MetricDataQueries: batch.map((definition, index): MetricDataQuery => ({
            Id: `m${index}`,
            ReturnData: true,
            MetricStat: {
              Period: 1800,
              Stat: definition.stat,
              Metric: {
                Namespace: definition.namespace,
                MetricName: definition.metricName,
                Dimensions: [...definition.dimensions],
              },
            },
          })),
        }));

        for (const result of response.MetricDataResults ?? []) {
          const definition = batch[Number(result.Id?.slice(1) ?? -1)];
          if (definition === undefined) {
            continue;
          }

          const timestamps = result.Timestamps ?? [];
          const values = result.Values ?? [];
          for (let index = 0; index < timestamps.length; index += 1) {
            const timestamp = timestamps[index];
            const value = values[index];
            if (timestamp === undefined || value === undefined) {
              continue;
            }

            samples.push({
              tenantId: job.tenantId,
              cloudConnectionId: job.cloudConnectionId,
              provider: 'AWS',
              externalResourceId: definition.externalResourceId,
              metricName: definition.metricName,
              value,
              sampledAt: timestamp,
              granularitySeconds: 1800,
              ...(definition.unit !== undefined ? { metricUnit: definition.unit } : {}),
              rawMetric: {
                namespace: definition.namespace,
                stat: definition.stat,
                region,
              },
            });
          }
        }
      }
    }

    return {
      apiCallCount,
      objectsProcessed: 0,
      focusRows: [],
      resources: [],
      metricSamples: samples,
      warnings: samples.length === 0 ? ['AWS CloudWatch returned no datapoints for the configured metric definitions.'] : [],
      coverage: {
        metricDefinitions: definitions.length,
        samples: samples.length,
        memoryRequiresCloudWatchAgent: true,
      },
    };
  }

  private async collectBillingExport(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    const credential = getCredential(job.connection.credentials, ['BILLING_EXPORT_READ', 'STORAGE_READ', 'OPERATIONAL']);
    if (credential === undefined) {
      throw new Error('AWS BILLING_EXPORT_READ, STORAGE_READ or OPERATIONAL credential is required');
    }

    const baseRegion = job.connection.defaultRegion ?? 'us-east-1';
    const assumed = await this.assumeRole(credential, baseRegion);
    let apiCallCount = 1;
    const discovery = await this.discoverFocusObjects(job, assumed, baseRegion);
    apiCallCount += discovery.apiCallCount;
    const objects = [...this.readFocusObjects(job), ...discovery.objects];

    if (objects.length === 0) {
      return this.emptyResult(0, [
        'No AWS FOCUS export objects configured or discovered. Configure awsFocusExportObjects or awsFocusExportLocations.',
      ], {
        costSource: 'AWS Data Exports FOCUS to S3',
        objectsConfigured: 0,
        prefixesConfigured: this.readFocusLocations(job).length,
      });
    }

    apiCallCount += objects.length;

    return {
      apiCallCount,
      objectsProcessed: objects.length,
      focusRows: [],
      focusBatches: this.streamFocusObjects(job, assumed, baseRegion, objects),
      resources: [],
      metricSamples: [],
      warnings: [],
      coverage: {
        costSource: 'AWS Data Exports FOCUS to S3',
        objectsConfigured: objects.length,
        objectsDiscovered: discovery.objects.length,
        prefixesConfigured: this.readFocusLocations(job).length,
        rowsParsed: 'streamed',
      },
    };
  }

  private async *streamFocusObjects(
    job: CloudIngestionJobContext,
    credentials: AwsCredentialIdentity,
    baseRegion: string,
    objects: readonly AwsFocusExportObject[],
  ): AsyncGenerator<readonly NormalizedFocusCostLineItem[]> {
    const batch: NormalizedFocusCostLineItem[] = [];
    for (const object of objects) {
      const client = this.createS3Client(object.region ?? baseRegion, credentials);
      const response = await client.send(new GetObjectCommand({
        Bucket: object.bucket,
        Key: object.key,
      }));

      for await (const line of parseFocusCsvStream(
        toAsyncByteChunks(response.Body),
        {
          tenantId: job.tenantId,
          cloudConnectionId: job.cloudConnectionId,
          provider: 'AWS',
          focusVersion: object.focusVersion,
        },
        object.key,
      )) {
        batch.push(line);
        if (batch.length >= 1000) {
          yield batch.splice(0, batch.length);
        }
      }
    }

    if (batch.length > 0) {
      yield batch;
    }
  }

  private async assumeRole(
    credential: NonNullable<ReturnType<typeof getCredential>>,
    region: string,
  ): Promise<AwsCredentialIdentity> {
    const roleArn = requireString(credential.payload['roleArn'], 'AWS roleArn');
    const externalId = optionalString(credential.payload['externalId']);
    const sessionName = optionalString(credential.payload['sessionName']) ?? 'finops-ingestion-worker';
    const client = this.createStsClient(region);
    const response = await client.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      ...(externalId !== undefined ? { ExternalId: externalId } : {}),
      DurationSeconds: 3600,
    }));

    if (
      response.Credentials?.AccessKeyId === undefined ||
      response.Credentials.SecretAccessKey === undefined ||
      response.Credentials.SessionToken === undefined
    ) {
      throw new Error('AWS STS AssumeRole did not return complete credentials');
    }

    return {
      accessKeyId: response.Credentials.AccessKeyId,
      secretAccessKey: response.Credentials.SecretAccessKey,
      sessionToken: response.Credentials.SessionToken,
    };
  }

  private readMetricDefinitions(job: CloudIngestionJobContext): readonly AwsMetricDefinition[] {
    return readObjectArray(job.connection.metadata, 'awsMetricDefinitions').map((item) => {
      const unit = optionalString(item['unit']);
      const region = optionalString(item['region']);

      return {
        externalResourceId: requireString(item['externalResourceId'], 'awsMetricDefinitions.externalResourceId'),
        namespace: requireString(item['namespace'], 'awsMetricDefinitions.namespace'),
        metricName: requireString(item['metricName'], 'awsMetricDefinitions.metricName'),
        stat: optionalString(item['stat']) ?? 'Average',
        ...(unit !== undefined ? { unit } : {}),
        ...(region !== undefined ? { region } : {}),
        dimensions: readObjectArray(item, 'dimensions').map((dimension) => ({
          Name: requireString(dimension['Name'], 'awsMetricDefinitions.dimensions.Name'),
          Value: requireString(dimension['Value'], 'awsMetricDefinitions.dimensions.Value'),
        })),
      };
    });
  }

private async collectInventoryResources(job: CloudIngestionJobContext): Promise<{
readonly apiCallCount: number;
readonly resources: readonly NormalizedCloudResource[];
readonly warnings: readonly string[];
readonly source: string;
}> {
const explicit = readObjectArray(job.connection.metadata, 'awsInventoryResources').map((item) => {
const regionId = optionalString(item['regionId']) ?? optionalString(item['region']) ?? job.connection.defaultRegion;
return {
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        provider: 'AWS' as const,
        externalResourceId: requireString(item['externalResourceId'], 'awsInventoryResources.externalResourceId'),
        name: optionalString(item['name'])
          ?? optionalString(item['displayName'])
          ?? requireString(item['externalResourceId'], 'awsInventoryResources.externalResourceId'),
        resourceType: optionalString(item['resourceType']) ?? 'COMPUTE_INSTANCE',
        serviceName: optionalString(item['serviceName']) ?? 'Amazon EC2',
        ...(regionId !== undefined ? { regionId } : {}),
        status: this.normalizeResourceStatus(optionalString(item['status'])),
        rawResource: {
          source: 'AWS_INVENTORY_METADATA',
          ...item,
        },
};
});

const defaultRegion = job.connection.defaultRegion ?? 'us-east-1';
const inferred = this.readMetricDefinitions(job).map((definition) => ({
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      provider: 'AWS' as const,
      externalResourceId: definition.externalResourceId,
      name: definition.externalResourceId,
      resourceType: this.inferResourceType(definition),
      serviceName: this.inferServiceName(definition),
      regionId: definition.region ?? defaultRegion,
      status: 'UNKNOWN' as const,
      rawResource: {
        source: 'AWS_METRIC_DEFINITION',
        namespace: definition.namespace,
        metricName: definition.metricName,
        dimensions: definition.dimensions,
      },
}));

let sdkResources: readonly NormalizedCloudResource[] = [];
let apiCallCount = 0;
const warnings: string[] = [];

try {
const credential = getCredential(job.connection.credentials, ['INVENTORY_READ', 'OPERATIONAL']);
if (credential !== undefined) {
const assumed = await this.assumeRole(credential, defaultRegion);
const inventory = await this.collectEc2InventoryResources(job, assumed, defaultRegion);
sdkResources = inventory.resources;
apiCallCount = inventory.apiCallCount + 1;
} else {
warnings.push('AWS inventory SDK skipped: missing INVENTORY_READ or OPERATIONAL credential.');
}
} catch (error) {
warnings.push(`AWS inventory SDK skipped: ${error instanceof Error ? error.message : String(error)}`);
}

const resources = this.mergeInventoryResources([...inferred, ...explicit, ...sdkResources]);

if (resources.length === 0) {
warnings.push('No AWS inventory resources found from EC2 SDK, metadata or CloudWatch metric definitions.');
}

return {
apiCallCount,
resources,
warnings,
source: sdkResources.length > 0 ? 'aws_ec2_sdk_with_metadata_fallback' : 'metadata_and_metric_definitions',
};
}

private async collectEc2InventoryResources(
job: CloudIngestionJobContext,
credentials: AwsCredentialIdentity,
defaultRegion: string,
): Promise<{ readonly apiCallCount: number; readonly resources: readonly NormalizedCloudResource[] }> {
const regions = this.readInventoryRegions(job, defaultRegion);
const resources: NormalizedCloudResource[] = [];
let apiCallCount = 0;

for (const region of regions) {
const client = this.createEc2Client(region, credentials);
let nextToken: string | undefined;

do {
apiCallCount += 1;
const response = await client.send(new DescribeInstancesCommand({
...(nextToken !== undefined ? { NextToken: nextToken } : {}),
}));

for (const reservation of response.Reservations ?? []) {
for (const instance of reservation.Instances ?? []) {
if (instance.InstanceId === undefined) continue;

const tags = this.tagsToRecord(instance.Tags);
resources.push({
tenantId: job.tenantId,
cloudConnectionId: job.cloudConnectionId,
provider: 'AWS',
externalResourceId: instance.InstanceId,
name: typeof tags['Name'] === 'string' && tags['Name'].trim() !== '' ? tags['Name'] : instance.InstanceId,
resourceType: 'COMPUTE_INSTANCE',
serviceName: 'Amazon EC2',
regionId: region,
status: this.normalizeResourceStatus(instance.State?.Name),
tags,
rawResource: {
source: 'AWS_EC2_SDK',
instanceType: instance.InstanceType,
state: instance.State?.Name,
availabilityZone: instance.Placement?.AvailabilityZone,
},
});
}
}

nextToken = response.NextToken;
} while (nextToken !== undefined);
}

return { apiCallCount, resources };
}

  private mergeInventoryResources(resources: readonly NormalizedCloudResource[]): readonly NormalizedCloudResource[] {
    const byExternalResourceId = new Map<string, NormalizedCloudResource>();
    for (const resource of resources) {
      const previous = byExternalResourceId.get(resource.externalResourceId);
      if (previous === undefined || previous.rawResource?.['source'] === 'AWS_METRIC_DEFINITION') {
        byExternalResourceId.set(resource.externalResourceId, resource);
      }
    }

    return [...byExternalResourceId.values()];
  }

  private inferResourceType(definition: AwsMetricDefinition): string {
    if (definition.namespace.toLowerCase().includes('ec2')) {
      return 'COMPUTE_INSTANCE';
    }

    if (definition.namespace.toLowerCase().includes('ebs')) {
      return 'BLOCK_VOLUME';
    }

    return 'UNKNOWN';
  }

  private inferServiceName(definition: AwsMetricDefinition): string {
    if (definition.namespace.toLowerCase().includes('ec2')) {
      return 'Amazon EC2';
    }

    if (definition.namespace.toLowerCase().includes('ebs')) {
      return 'Amazon EBS';
    }

    return 'UNKNOWN';
  }

  private normalizeResourceStatus(status: string | undefined): NormalizedCloudResource['status'] {
    const normalized = status?.toUpperCase();
    if (normalized === 'ACTIVE' || normalized === 'RUNNING' || normalized === 'AVAILABLE') {
      return 'ACTIVE';
    }

    if (normalized === 'STOPPED' || normalized === 'STOPPING') {
      return 'STOPPED';
    }

    if (normalized === 'TERMINATED' || normalized === 'DELETED') {
      return 'TERMINATED';
    }

    return 'UNKNOWN';
  }

  private readFocusObjects(job: CloudIngestionJobContext): readonly AwsFocusExportObject[] {
    return readObjectArray(job.connection.metadata, 'awsFocusExportObjects').map((item) => {
      const region = optionalString(item['region']);

      return {
        bucket: requireString(item['bucket'], 'awsFocusExportObjects.bucket'),
        key: requireString(item['key'], 'awsFocusExportObjects.key'),
        focusVersion: optionalString(item['focusVersion']) ?? '1.0',
        ...(region !== undefined ? { region } : {}),
      };
    });
  }

  private readFocusLocations(job: CloudIngestionJobContext): readonly AwsFocusExportLocation[] {
    return readObjectArray(job.connection.metadata, 'awsFocusExportLocations').map((item) => {
      const region = optionalString(item['region']);
      return {
        bucket: requireString(item['bucket'], 'awsFocusExportLocations.bucket'),
        prefix: requireString(item['prefix'], 'awsFocusExportLocations.prefix'),
        focusVersion: optionalString(item['focusVersion']) ?? '1.0',
        maxObjects: readBoundedPositiveInteger(item['maxObjects'], 100, 1, 1000),
        ...(region !== undefined ? { region } : {}),
      };
    });
  }

  private async discoverFocusObjects(
    job: CloudIngestionJobContext,
    credentials: AwsCredentialIdentity,
    defaultRegion: string,
  ): Promise<{ readonly objects: readonly AwsFocusExportObject[]; readonly apiCallCount: number }> {
    const locations = this.readFocusLocations(job);
    const discovered: AwsFocusExportObject[] = [];
    let apiCallCount = 0;

    for (const location of locations) {
      const client = this.createS3Client(location.region ?? defaultRegion, credentials);
      let continuationToken: string | undefined;

      while (discovered.length < location.maxObjects) {
        apiCallCount += 1;
        const response = await client.send(new ListObjectsV2Command({
          Bucket: location.bucket,
          Prefix: location.prefix,
          MaxKeys: Math.min(1000, location.maxObjects - discovered.length),
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }));

        for (const object of response.Contents ?? []) {
          if (object.Key === undefined || !this.isFocusObjectName(object.Key)) {
            continue;
          }

          discovered.push({
            bucket: location.bucket,
            key: object.Key,
            focusVersion: location.focusVersion,
            ...(location.region !== undefined ? { region: location.region } : {}),
          });
        }

        if (response.IsTruncated !== true || response.NextContinuationToken === undefined) {
          break;
        }

        continuationToken = response.NextContinuationToken;
      }
    }

    return { objects: discovered, apiCallCount };
  }

  private groupByRegion(
    definitions: readonly AwsMetricDefinition[],
    defaultRegion: string,
  ): ReadonlyMap<string, readonly AwsMetricDefinition[]> {
    const grouped = new Map<string, AwsMetricDefinition[]>();
    for (const definition of definitions) {
      const region = definition.region ?? defaultRegion;
      grouped.set(region, [...(grouped.get(region) ?? []), definition]);
    }

    return grouped;
  }

  private chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

private createCloudWatchClient(region: string, credentials: AwsCredentialIdentity): AwsCommandClient<AwsMetricDataResponse> {
return new CloudWatchClient({
region,
credentials,
maxAttempts: 2,
}) as AwsCommandClient<AwsMetricDataResponse>;
}

private createEc2Client(
region: string,
credentials: AwsCredentialIdentity,
): AwsCommandClient<AwsDescribeInstancesResponse> {
return new EC2Client({
region,
credentials,
maxAttempts: 2,
}) as AwsCommandClient<AwsDescribeInstancesResponse>;
}

private createS3Client(
region: string,
credentials: AwsCredentialIdentity,
): AwsCommandClient<AwsGetObjectResponse & AwsListObjectsResponse> {
    return new S3Client({
      region,
      credentials,
      maxAttempts: 2,
    }) as AwsCommandClient<AwsGetObjectResponse & AwsListObjectsResponse>;
  }

private createStsClient(region: string): AwsCommandClient<AwsAssumeRoleResponse> {
return new STSClient({ region, maxAttempts: 2 }) as AwsCommandClient<AwsAssumeRoleResponse>;
}

private readInventoryRegions(job: CloudIngestionJobContext, defaultRegion: string): readonly string[] {
const configured = readStringArray(job.connection.metadata?.['awsInventoryRegions']);
const metricRegions = this.readMetricDefinitions(job)
.map((definition) => definition.region)
.filter((region): region is string => region !== undefined);

return [...new Set([...configured, ...metricRegions, defaultRegion])];
}

private tagsToRecord(tags: readonly { readonly Key?: string; readonly Value?: string }[] | undefined): Readonly<Record<string, unknown>> {
const record: Record<string, unknown> = {};
for (const tag of tags ?? []) {
if (tag.Key !== undefined && tag.Value !== undefined) {
record[tag.Key] = tag.Value;
}
}
return record;
}

private emptyResult(
apiCallCount: number,
warnings: readonly string[],
    coverage: Readonly<Record<string, unknown>>,
  ): CloudIngestionResult {
    return {
      apiCallCount,
      objectsProcessed: 0,
      focusRows: [],
      resources: [],
      metricSamples: [],
      warnings,
      coverage,
    };
  }

  private isFocusObjectName(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith('.csv') || lower.endsWith('.csv.gz');
  }
}

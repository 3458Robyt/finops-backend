import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { createHash } from 'node:crypto';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  CloudIngestionConnection,
  CloudConnectionValidationResult,
  CloudCapabilityValidation,
  CloudIngestionProvider,
  CloudIngestionResult,
  FocusSourcePreviewResult,
  NormalizedCloudResource,
  NormalizedFocusCostLineItem,
  NormalizedProviderCostLineItem,
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
import { resolveBillingSource } from './billingSourceMode.js';

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
  readonly sizeBytes?: number;
  readonly lastModified?: Date;
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
  destroy?(): void;
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
readonly Size?: number;
readonly LastModified?: Date;
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

interface AwsCallerIdentityResponse {
  readonly Account?: string;
  readonly Arn?: string;
}

interface AwsCostExplorerResponse {
  readonly ResultsByTime?: readonly {
    readonly TimePeriod?: { readonly Start?: string; readonly End?: string };
    readonly Groups?: readonly {
      readonly Keys?: readonly string[];
      readonly Metrics?: Readonly<Record<string, { readonly Amount?: string; readonly Unit?: string }>>;
    }[];
  }[];
  readonly NextPageToken?: string;
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

  public async validate(connection: CloudIngestionConnection): Promise<CloudConnectionValidationResult> {
    const checkedAt = new Date();
    const credential = getCredential(connection.credentials, [
      'OPERATIONAL',
      'INVENTORY_READ',
      'METRICS_READ',
      'BILLING_EXPORT_READ',
      'STORAGE_READ',
    ]);
    if (credential === undefined) {
      return {
        providerCode: this.providerCode,
        capabilities: missingCredentialCapabilities(checkedAt, 'No hay una credencial AWS de lectura activa.'),
      };
    }

    const region = optionalString(credential.payload['region']) ?? connection.defaultRegion ?? 'us-east-1';
    let assumed: AwsCredentialIdentity;
    try {
      assumed = await this.assumeRole(credential, region);
    } catch (error) {
      const failure = failedCapability('IDENTITY', error, checkedAt);
      return {
        providerCode: this.providerCode,
        capabilities: [
          failure,
          ...(['INVENTORY', 'COSTS', 'METRICS', 'STORAGE'] as const).map((capability) => ({
            capability,
            status: failure.status,
            message: 'No se puede comprobar esta capacidad porque AWS STS AssumeRole falló.',
            checkedAt,
          })),
        ],
      };
    }

    const identity = await validateAwsCall('IDENTITY', checkedAt, async () => {
      const response = await this.createIdentityClient(region, assumed).send(new GetCallerIdentityCommand({}));
      if (response.Account !== undefined && /^\d{12}$/.test(connection.rootExternalId) && response.Account !== connection.rootExternalId) {
        throw new Error('La cuenta devuelta por AWS no coincide con la conexión configurada.');
      }
      return {
        message: 'AWS AssumeRole e identidad validados.',
        metadata: {
          ...(response.Account !== undefined ? { accountId: response.Account } : {}),
          ...(response.Arn !== undefined ? { principalArn: response.Arn } : {}),
        },
      };
    });

    const inventory = await validateAwsCall('INVENTORY', checkedAt, async () => {
      await this.createEc2Client(region, assumed).send(new DescribeInstancesCommand({ MaxResults: 5 }));
      return { message: 'Lectura de inventario EC2 disponible.', metadata: { region } };
    });

    const costs = await validateAwsCall('COSTS', checkedAt, async () => {
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      await this.createCostExplorerClient(assumed).send(new GetCostAndUsageCommand({
        TimePeriod: { Start: toAwsDate(start), End: toAwsDate(end) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
      }));
      return { message: 'AWS Cost Explorer disponible.' };
    });

    const metrics = await validateAwsCall('METRICS', checkedAt, async () => {
      await this.createCloudWatchClient(region, assumed).send(new ListMetricsCommand({}));
      return { message: 'Lectura de métricas CloudWatch disponible.', metadata: { region } };
    });

    const storage = await this.validateStorageCapability(connection, assumed, region, checkedAt);
    return { providerCode: this.providerCode, capabilities: [identity, inventory, costs, metrics, storage] };
  }

  public async previewFocus(connection: CloudIngestionConnection, limit: number): Promise<FocusSourcePreviewResult> {
    const credential = getCredential(connection.credentials, ['BILLING_EXPORT_READ', 'STORAGE_READ', 'OPERATIONAL']);
    if (credential === undefined) throw new Error('No hay una credencial AWS activa para leer el export FOCUS.');
    const region = optionalString(credential.payload['region']) ?? connection.defaultRegion ?? 'us-east-1';
    const credentials = await this.assumeRole(credential, region);
    const job = buildAwsPreviewJob(connection);
    const configured = this.readFocusObjects(job);
    const discovery = await this.discoverFocusObjects(job, credentials, region, true);
    const objects = [
      ...configured.map((object) => ({ object, source: 'configured' as const })),
      ...discovery.objects.map((object) => ({ object, source: 'discovered' as const })),
    ].slice(0, limit).map(({ object, source }) => ({
      name: object.key,
      location: `s3://${object.bucket}/${object.key}`,
      source,
      ...(object.sizeBytes !== undefined ? { sizeBytes: object.sizeBytes } : {}),
      ...(object.lastModified !== undefined ? { lastModified: object.lastModified } : {}),
    }));
    return buildFocusPreviewResult('aws', this.readFocusLocations(job).length, configured.length, discovery.objects.length, objects, discovery.errors);
  }

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
    if (resolveBillingSource(job) === 'PROVIDER_API') {
      return this.collectProviderApiCosts(job);
    }
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

  private async collectProviderApiCosts(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    const credential = getCredential(job.connection.credentials, ['BILLING_EXPORT_READ', 'OPERATIONAL']);
    if (credential === undefined) throw new Error('AWS BILLING_EXPORT_READ or OPERATIONAL credential is required');
    const region = job.connection.defaultRegion ?? 'us-east-1';
    const credentials = await this.assumeRole(credential, region);
    const client = this.createCostExplorerClient(credentials);
    const rows: NormalizedProviderCostLineItem[] = [];
    let nextPageToken: string | undefined;
    let apiCallCount = 1;
    do {
      const response = await client.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: job.targetStart.toISOString().slice(0, 10), End: job.targetEnd.toISOString().slice(0, 10) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost', 'UsageQuantity'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        ...(nextPageToken === undefined ? {} : { NextPageToken: nextPageToken }),
      }));
      apiCallCount += 1;
      for (const day of response.ResultsByTime ?? []) {
        const start = day.TimePeriod?.Start;
        const end = day.TimePeriod?.End;
        if (start === undefined || end === undefined) continue;
        for (const group of day.Groups ?? []) {
          const cost = Number(group.Metrics?.['UnblendedCost']?.Amount ?? '0');
          if (!Number.isFinite(cost)) continue;
          const serviceName = group.Keys?.[0] ?? 'Uncategorized';
          const usage = Number(group.Metrics?.['UsageQuantity']?.Amount ?? '');
          const rawRow = { start, end, serviceName, metrics: group.Metrics ?? {} };
          rows.push({
            tenantId: job.tenantId,
            cloudConnectionId: job.cloudConnectionId,
            provider: 'AWS',
            chargePeriodStart: new Date(`${start}T00:00:00.000Z`),
            chargePeriodEnd: new Date(`${end}T00:00:00.000Z`),
            billingAccountId: job.connection.rootExternalId,
            serviceName,
            resourceId: '',
            billedCost: cost,
            billingCurrency: group.Metrics?.['UnblendedCost']?.Unit ?? 'USD',
            ...(Number.isFinite(usage) ? { consumedQuantity: usage, consumedUnit: group.Metrics?.['UsageQuantity']?.Unit ?? 'N/A' } : {}),
            sourceMetric: 'AWS_UNBLENDED_COST',
            rawRow,
            lineItemHash: createHash('sha256').update(JSON.stringify(rawRow)).digest('hex'),
          });
        }
      }
      nextPageToken = response.NextPageToken;
    } while (nextPageToken !== undefined);
    return { apiCallCount, objectsProcessed: 0, focusRows: [], providerCostRows: rows, resources: [], metricSamples: [], warnings: rows.length === 0 ? ['AWS Cost Explorer returned no costs for the requested range.'] : [], coverage: { billingSource: 'PROVIDER_API', costSource: 'AWS Cost Explorer', rows: rows.length } };
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

  private async validateStorageCapability(
    connection: CloudIngestionConnection,
    credentials: AwsCredentialIdentity,
    defaultRegion: string,
    checkedAt: Date,
  ): Promise<CloudCapabilityValidation> {
    const location = readObjectArray(connection.metadata, 'awsFocusExportLocations')[0];
    const object = readObjectArray(connection.metadata, 'awsFocusExportObjects')[0];
    const bucket = optionalString(location?.['bucket']) ?? optionalString(object?.['bucket']);
    const prefix = optionalString(location?.['prefix']) ?? optionalString(object?.['key']) ?? '';
    if (bucket === undefined) {
      return {
        capability: 'STORAGE',
        status: 'NOT_CONFIGURED',
        message: 'Configura un bucket o prefijo FOCUS para validar almacenamiento S3.',
        checkedAt,
      };
    }

    const region = optionalString(location?.['region']) ?? optionalString(object?.['region']) ?? defaultRegion;
    return validateAwsCall('STORAGE', checkedAt, async () => {
      await this.createS3Client(region, credentials).send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1,
      }));
      return { message: 'Lectura del almacenamiento FOCUS en S3 disponible.', metadata: { bucket, region } };
    });
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
    tolerateErrors = false,
  ): Promise<{ readonly objects: readonly AwsFocusExportObject[]; readonly apiCallCount: number; readonly errors: readonly string[] }> {
    const locations = this.readFocusLocations(job);
    const discovered: AwsFocusExportObject[] = [];
    let apiCallCount = 0;
    const errors: string[] = [];

    for (const location of locations) {
      const client = this.createS3Client(location.region ?? defaultRegion, credentials);
      let continuationToken: string | undefined;
      const locationStartCount = discovered.length;

      try {
      while (discovered.length - locationStartCount < location.maxObjects) {
        apiCallCount += 1;
        const response = await client.send(new ListObjectsV2Command({
          Bucket: location.bucket,
          Prefix: location.prefix,
          MaxKeys: Math.min(1000, location.maxObjects - (discovered.length - locationStartCount)),
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
            ...(object.Size !== undefined ? { sizeBytes: object.Size } : {}),
            ...(object.LastModified !== undefined ? { lastModified: object.LastModified } : {}),
            ...(location.region !== undefined ? { region: location.region } : {}),
          });
        }

        if (response.IsTruncated !== true || response.NextContinuationToken === undefined) {
          break;
        }

        continuationToken = response.NextContinuationToken;
      }
      } catch (error) {
        if (!tolerateErrors) throw error;
        errors.push(`${location.bucket}/${location.prefix}: ${safeProviderError(error)}`);
      } finally {
        client.destroy?.();
      }
    }

    return { objects: discovered, apiCallCount, errors };
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


private createCostExplorerClient(credentials: AwsCredentialIdentity): AwsCommandClient<AwsCostExplorerResponse> {
return new CostExplorerClient({ region: 'us-east-1', credentials, maxAttempts: 2 }) as AwsCommandClient<AwsCostExplorerResponse>;
}

private createIdentityClient(
region: string,
credentials: AwsCredentialIdentity,
): AwsCommandClient<AwsCallerIdentityResponse> {
return new STSClient({ region, credentials, maxAttempts: 2 }) as AwsCommandClient<AwsCallerIdentityResponse>;
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

async function validateAwsCall(
  capability: CloudCapabilityValidation['capability'],
  checkedAt: Date,
  operation: () => Promise<{
    readonly message: string;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  }>,
): Promise<CloudCapabilityValidation> {
  try {
    const result = await operation();
    return {
      capability,
      status: 'AVAILABLE',
      message: result.message,
      checkedAt,
      ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
    };
  } catch (error) {
    return failedCapability(capability, error, checkedAt);
  }
}

function failedCapability(
  capability: CloudCapabilityValidation['capability'],
  error: unknown,
  checkedAt: Date,
): CloudCapabilityValidation {
  const message = safeProviderError(error);
  return {
    capability,
    status: /access.?denied|unauthori[sz]ed|not authorized|forbidden/i.test(message) ? 'DENIED' : 'ERROR',
    message,
    checkedAt,
  };
}

function missingCredentialCapabilities(
  checkedAt: Date,
  message: string,
): readonly CloudCapabilityValidation[] {
  return (['IDENTITY', 'INVENTORY', 'COSTS', 'METRICS', 'STORAGE'] as const).map((capability) => ({
    capability,
    status: 'NOT_CONFIGURED',
    message,
    checkedAt,
  }));
}

function safeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/(secret|token|key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]').slice(0, 300);
}

function toAwsDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildAwsPreviewJob(connection: CloudIngestionConnection): CloudIngestionJobContext {
  const targetEnd = new Date();
  return {
    id: `focus-preview-${connection.id}`,
    tenantId: connection.tenantId,
    cloudConnectionId: connection.id,
    sourceType: 'BILLING_EXPORT',
    targetStart: new Date(targetEnd.getTime() - 24 * 60 * 60 * 1000),
    targetEnd,
    attempt: 0,
    connection,
  };
}

function buildFocusPreviewResult(
  providerCode: 'aws',
  configuredLocations: number,
  configuredObjects: number,
  discoveredObjects: number,
  objects: FocusSourcePreviewResult['objects'],
  errors: readonly string[],
): FocusSourcePreviewResult {
  const dates = objects.flatMap((object) => object.lastModified === undefined ? [] : [object.lastModified]);
  return {
    providerCode,
    configuredLocations,
    configuredObjects,
    discoveredObjects,
    approximateBytes: objects.reduce((sum, object) => sum + (object.sizeBytes ?? 0), 0),
    sizedObjects: objects.filter((object) => object.sizeBytes !== undefined).length,
    supportedFormats: ['csv', 'csv.gz'],
    errors,
    ...(dates.length > 0 ? {
      earliestObjectAt: new Date(Math.min(...dates.map((date) => date.getTime()))),
      latestObjectAt: new Date(Math.max(...dates.map((date) => date.getTime()))),
    } : {}),
    objects,
  };
}

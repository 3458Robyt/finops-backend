import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@smithy/types';
import { Readable } from 'node:stream';
import type {
  CloudIngestionJobContext,
  CloudIngestionProvider,
  CloudIngestionResult,
  NormalizedFocusCostLineItem,
  NormalizedResourceMetricSample,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { decodeMaybeGzip, parseFocusCsvToLineItems } from './focusCsvIngestion.js';
import {
  getCredential,
  optionalString,
  readBoundedPositiveInteger,
  readObjectArray,
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

export class AwsSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'aws';

  public async collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    if (job.sourceType === 'BILLING_EXPORT') {
      return this.collectBillingExport(job);
    }

    if (job.sourceType === 'INVENTORY') {
      return this.emptyResult(0, [
        'AWS inventory collection is pending; only CloudWatch technical metrics are implemented in this worker slice.',
      ], {
        inventoryImplemented: false,
      });
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

    const focusRows: NormalizedFocusCostLineItem[] = [];

    for (const object of objects) {
      apiCallCount += 1;
      const client = this.createS3Client(object.region ?? baseRegion, assumed);
      const response = await client.send(new GetObjectCommand({
        Bucket: object.bucket,
        Key: object.key,
      }));
      const bytes = await this.bodyToBytes(response.Body);
      const csvText = decodeMaybeGzip(bytes, object.key);
      focusRows.push(...parseFocusCsvToLineItems({
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        provider: 'AWS',
        focusVersion: object.focusVersion,
        csvText,
      }));
    }

    return {
      apiCallCount,
      objectsProcessed: objects.length,
      focusRows,
      resources: [],
      metricSamples: [],
      warnings: focusRows.length === 0 ? ['AWS FOCUS objects were read but no valid rows were parsed.'] : [],
      coverage: {
        costSource: 'AWS Data Exports FOCUS to S3',
        objectsConfigured: objects.length,
        objectsDiscovered: discovery.objects.length,
        prefixesConfigured: this.readFocusLocations(job).length,
        rowsParsed: focusRows.length,
      },
    };
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

  private async bodyToBytes(body: unknown): Promise<Uint8Array> {
    if (body instanceof Uint8Array) {
      return body;
    }

    if (body instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    }

    if (
      body !== null &&
      typeof body === 'object' &&
      'transformToByteArray' in body &&
      typeof body.transformToByteArray === 'function'
    ) {
      return body.transformToByteArray() as Promise<Uint8Array>;
    }

    throw new Error('Unsupported AWS S3 body type');
  }

  private isFocusObjectName(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith('.csv') || lower.endsWith('.csv.gz');
  }
}

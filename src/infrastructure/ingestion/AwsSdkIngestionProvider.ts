import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  CloudIngestionProvider,
  CloudIngestionResult,
  NormalizedResourceMetricSample,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, optionalString, readObjectArray, requireString } from './providerConfig.js';

interface AwsMetricDefinition {
  readonly externalResourceId: string;
  readonly namespace: string;
  readonly metricName: string;
  readonly dimensions: readonly { readonly Name: string; readonly Value: string }[];
  readonly stat: string;
  readonly unit?: string;
  readonly region?: string;
}

export class AwsSdkIngestionProvider implements CloudIngestionProvider {
  public readonly providerCode = 'aws';

  public async collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult> {
    if (job.sourceType === 'BILLING_EXPORT') {
      return this.emptyResult(0, [
        'AWS FOCUS Data Export discovery is configured as the canonical cost source, but S3 export parsing is pending for this connector run.',
      ], {
        costSource: 'AWS Data Exports FOCUS to S3',
        implemented: false,
      });
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
      const client = new CloudWatchClient({
        region,
        credentials: assumed,
        maxAttempts: 2,
      });

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

  private async assumeRole(
    credential: NonNullable<ReturnType<typeof getCredential>>,
    region: string,
  ): Promise<AwsCredentialIdentity> {
    const roleArn = requireString(credential.payload['roleArn'], 'AWS roleArn');
    const externalId = optionalString(credential.payload['externalId']);
    const sessionName = optionalString(credential.payload['sessionName']) ?? 'finops-ingestion-worker';
    const client = new STSClient({ region, maxAttempts: 2 });
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
}

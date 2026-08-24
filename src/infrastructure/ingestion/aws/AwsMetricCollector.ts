import { GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedResourceMetricSample,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { MetricStatistic } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential } from '../providerConfig.js';
import type { AwsCommandClient, AwsMetricDataResponse } from './awsContracts.js';
import {
  chunkAwsItems,
  groupAwsMetricsByRegion,
  readAwsMetricDefinitions,
} from './awsConfiguration.js';

interface AwsMetricCollectorDependencies {
  readonly assumeRole: (
    credential: NonNullable<ReturnType<typeof getCredential>>,
    region: string,
  ) => Promise<AwsCredentialIdentity>;
  readonly createCloudWatchClient: (
    region: string,
    credentials: AwsCredentialIdentity,
  ) => AwsCommandClient<AwsMetricDataResponse>;
}

export async function collectAwsTechnicalMetrics(
  job: CloudIngestionJobContext,
  dependencies: AwsMetricCollectorDependencies,
): Promise<CloudIngestionResult> {
  const definitions = readAwsMetricDefinitions(job);
  if (definitions.length === 0) {
    return emptyMetricResult([
      'No AWS CloudWatch metric definitions configured in cloud connection metadata key awsMetricDefinitions.',
    ], { metricDefinitions: 0 });
  }

  const credential = getCredential(job.connection.credentials, ['METRICS_READ', 'OPERATIONAL']);
  if (credential === undefined) throw new Error('AWS METRICS_READ or OPERATIONAL credential is required');

  const baseRegion = job.connection.defaultRegion ?? 'us-east-1';
  const assumed = await dependencies.assumeRole(credential, baseRegion);
  const samples: NormalizedResourceMetricSample[] = [];
  let apiCallCount = 1;

  for (const [region, regionDefinitions] of groupAwsMetricsByRegion(definitions, baseRegion)) {
    const client = dependencies.createCloudWatchClient(region, assumed);
    for (const batch of chunkAwsItems(regionDefinitions, 500)) {
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
        if (definition === undefined) continue;
        const statistic = normalizeAwsStatistic(definition.stat);
        const timestamps = result.Timestamps ?? [];
        const values = result.Values ?? [];
        for (let index = 0; index < timestamps.length; index += 1) {
          const timestamp = timestamps[index];
          const value = values[index];
          if (timestamp === undefined || value === undefined) continue;
          samples.push({
            tenantId: job.tenantId,
            cloudConnectionId: job.cloudConnectionId,
            provider: 'AWS',
            externalResourceId: definition.externalResourceId,
            metricName: definition.metricName,
            statistic,
            value,
            sampledAt: timestamp,
            granularitySeconds: 1800,
            ...(definition.unit !== undefined ? { metricUnit: definition.unit } : {}),
            rawMetric: { namespace: definition.namespace, stat: definition.stat, statistic, region },
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
    warnings: samples.length === 0
      ? ['AWS CloudWatch returned no datapoints for the configured metric definitions.']
      : [],
    coverage: {
      metricDefinitions: definitions.length,
      samples: samples.length,
      memoryRequiresCloudWatchAgent: true,
    },
  };
}

function normalizeAwsStatistic(value: string): MetricStatistic {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'minimum' || normalized === 'min') return 'MIN';
  if (normalized === 'maximum' || normalized === 'max') return 'MAX';
  if (normalized === 'sum') return 'SUM';
  if (normalized === 'samplecount' || normalized === 'count') return 'COUNT';
  const percentile = /^p(50|90|95|99)(?:\.\d+)?$/.exec(normalized);
  if (percentile !== null) return `P${percentile[1]}` as MetricStatistic;
  return 'MEAN';
}

function emptyMetricResult(
  warnings: readonly string[],
  coverage: Readonly<Record<string, unknown>>,
): CloudIngestionResult {
  return {
    apiCallCount: 0,
    objectsProcessed: 0,
    focusRows: [],
    resources: [],
    metricSamples: [],
    warnings,
    coverage,
  };
}

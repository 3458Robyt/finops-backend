import { GetMetricDataCommand, ListMetricsCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import type { AwsCredentialIdentity } from '@smithy/types';
import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedResourceMetricSample,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { MetricStatistic } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { getCredential, readStringArray } from '../providerConfig.js';
import type { AwsCommandClient, AwsListMetricsResponse, AwsMetricDataResponse } from './awsContracts.js';
import {
  chunkAwsItems,
  groupAwsMetricsByRegion,
  readAwsMetricDiscoveryConfig,
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
  ) => AwsCommandClient<AwsMetricDataResponse & AwsListMetricsResponse>;
}

export async function collectAwsTechnicalMetrics(
  job: CloudIngestionJobContext,
  dependencies: AwsMetricCollectorDependencies,
): Promise<CloudIngestionResult> {
  const configuredDefinitions = readAwsMetricDefinitions(job);
  const credential = getCredential(job.connection.credentials, ['METRICS_READ', 'OPERATIONAL']);
  if (credential === undefined) {
    return emptyMetricResult([
      configuredDefinitions.length > 0
        ? 'Se requiere una credencial AWS METRICS_READ u OPERATIONAL para consultar CloudWatch.'
        : 'No hay definiciones de métricas ni credenciales AWS para descubrir métricas de CloudWatch.',
    ], { metricDefinitions: configuredDefinitions.length });
  }

  const baseRegion = job.connection.defaultRegion ?? 'us-east-1';
  const assumed = await dependencies.assumeRole(credential, baseRegion);
  const discovery = configuredDefinitions.length > 0
    ? { definitions: configuredDefinitions, apiCallCount: 0, warnings: [] as readonly string[] }
    : await discoverAwsMetricDefinitions(job, assumed, baseRegion, dependencies);
  const definitions = discovery.definitions;
  if (definitions.length === 0) {
    return emptyMetricResult([
      ...discovery.warnings,
      'CloudWatch no devolvió métricas con dimensiones de recurso para el catálogo configurado.',
    ], { metricDefinitions: 0, discoveryApiCalls: discovery.apiCallCount });
  }

  const samples: NormalizedResourceMetricSample[] = [];
  const warnings: string[] = [];
  let apiCallCount = 1 + discovery.apiCallCount;

  for (const [region, regionDefinitions] of groupAwsMetricsByRegion(definitions, baseRegion)) {
    const client = dependencies.createCloudWatchClient(region, assumed);
    try {
    for (const batch of chunkAwsItems(regionDefinitions, 500)) {
      let nextToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        apiCallCount += 1;
        const response = await client.send(new GetMetricDataCommand({
          StartTime: job.targetStart,
          EndTime: job.targetEnd,
          ScanBy: 'TimestampAscending',
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
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
          if (result.StatusCode !== undefined && result.StatusCode !== 'Complete') {
            warnings.push(`CloudWatch devolvió ${result.StatusCode} para una serie ${result.Id ?? 'desconocida'} en ${region}.`);
          }
          for (const message of result.Messages ?? []) {
            if (message.Value !== undefined && message.Value.trim() !== '') {
              warnings.push(`CloudWatch: ${message.Value.trim()}`);
            }
          }
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
        const receivedToken = response.NextToken;
        if (receivedToken !== undefined && seenTokens.has(receivedToken)) {
          warnings.push(`CloudWatch devolvió un cursor repetido para ${region}; se detuvo la paginación para evitar un ciclo.`);
          nextToken = undefined;
        } else {
          if (receivedToken !== undefined) seenTokens.add(receivedToken);
          nextToken = receivedToken;
        }
      } while (nextToken !== undefined);
    }
    } finally {
      client.destroy?.();
    }
  }

  return {
    apiCallCount,
    objectsProcessed: 0,
    focusRows: [],
    resources: [],
    metricSamples: samples,
    warnings: samples.length === 0
      ? [...warnings, 'AWS CloudWatch no devolvió puntos para las definiciones de métricas configuradas.']
      : warnings,
    coverage: {
      metricDefinitions: definitions.length,
      samples: samples.length,
      memoryRequiresCloudWatchAgent: true,
    },
  };
}

async function discoverAwsMetricDefinitions(
  job: CloudIngestionJobContext,
  credentials: AwsCredentialIdentity,
  defaultRegion: string,
  dependencies: AwsMetricCollectorDependencies,
): Promise<{
  readonly definitions: readonly ReturnType<typeof readAwsMetricDefinitions>[number][];
  readonly apiCallCount: number;
  readonly warnings: readonly string[];
}> {
  const config = readAwsMetricDiscoveryConfig(job);
  const configuredRegions = readStringArray(job.connection.metadata?.['awsMetricDiscoveryRegions']);
  const regions = configuredRegions.length > 0 ? [...new Set(configuredRegions)] : [defaultRegion];
  const definitions: ReturnType<typeof readAwsMetricDefinitions>[number][] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  let apiCallCount = 0;
  const maxDefinitions = 10_000;

  for (const region of regions) {
    const client = dependencies.createCloudWatchClient(region, credentials);
    try {
      for (const namespace of config.namespaces) {
        for (const metricName of config.metricNames) {
          let nextToken: string | undefined;
          const seenTokens = new Set<string>();
          do {
            apiCallCount += 1;
            const response = await client.send(new ListMetricsCommand({
              Namespace: namespace,
              MetricName: metricName,
              ...(nextToken === undefined ? {} : { NextToken: nextToken }),
            }));
            for (const metric of response.Metrics ?? []) {
              const resolvedNamespace = metric.Namespace ?? namespace;
              const resolvedMetricName = metric.MetricName ?? metricName;
              const dimensions = (metric.Dimensions ?? [])
                .flatMap((dimension) => dimension.Name !== undefined && dimension.Value !== undefined
                  ? [{ Name: dimension.Name, Value: dimension.Value }]
                  : []);
              const externalResourceId = resourceIdFromAwsDimensions(dimensions);
              if (externalResourceId === undefined) continue;
              for (const stat of config.statistics) {
                const identity = JSON.stringify({ region, resolvedNamespace, resolvedMetricName, dimensions, stat, externalResourceId });
                if (seen.has(identity)) continue;
                seen.add(identity);
                definitions.push({
                  externalResourceId,
                  namespace: resolvedNamespace,
                  metricName: resolvedMetricName,
                  dimensions,
                  stat,
                  ...(metric.Unit !== undefined ? { unit: metric.Unit } : {}),
                  region,
                });
                if (definitions.length >= maxDefinitions) {
                  warnings.push(`CloudWatch superó el límite seguro de ${maxDefinitions} definiciones descubiertas.`);
                  return { definitions, apiCallCount, warnings };
                }
              }
            }
            const receivedToken = response.NextToken;
            if (receivedToken !== undefined && seenTokens.has(receivedToken)) {
              warnings.push(`CloudWatch devolvió un cursor repetido al descubrir ${namespace}/${metricName} en ${region}.`);
              nextToken = undefined;
            } else {
              if (receivedToken !== undefined) seenTokens.add(receivedToken);
              nextToken = receivedToken;
            }
          } while (nextToken !== undefined);
        }
      }
    } catch (error) {
      warnings.push(`No se pudieron descubrir métricas CloudWatch en ${region}: ${error instanceof Error ? error.message : String(error)}.`);
    } finally {
      client.destroy?.();
    }
  }

  return { definitions, apiCallCount, warnings };
}

function resourceIdFromAwsDimensions(
  dimensions: readonly { readonly Name: string; readonly Value: string }[],
): string | undefined {
  const preferred = dimensions.find((dimension) => /^(instanceid|volumeid)$/i.test(dimension.Name));
  if (preferred !== undefined) return preferred.Value;
  return dimensions.find((dimension) => /^(i-|vol-)/i.test(dimension.Value))?.Value;
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

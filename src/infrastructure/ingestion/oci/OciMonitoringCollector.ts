import { createHash } from 'node:crypto';
import type {
  CloudIngestionJobContext,
  CloudIngestionResult,
  NormalizedResourceMetricSample,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { METRIC_STATISTICS, type MetricStatistic } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { normalizeExternalResourceId } from '../../../domain/models/ResourceLinkage.js';
import { optionalString, readObjectArray, readStringArray, requireString } from '../providerConfig.js';
import type { OciMetricDefinition, OciMonitoringClient } from './OciSdkContracts.js';
import { buildOciCollectionTasks, type OciCollectionTask } from './OciMonitoringQueryBuilder.js';
export { buildOciGroupedMetricQuery, buildOciResourceMetricQuery } from './OciMonitoringQueryBuilder.js';

export interface OciMonitoringDependencies {
  readonly createClient: (job: CloudIngestionJobContext) => OciMonitoringClient;
  readonly withRetry: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly withRateLimit?: <T>(job: CloudIngestionJobContext, operation: () => Promise<T>) => Promise<T>;
}

export async function collectOciTechnicalMetrics(
  job: CloudIngestionJobContext,
  dependencies: OciMonitoringDependencies,
): Promise<CloudIngestionResult> {
  const definitions = readOciMetricDefinitions(job);
  if (definitions.length === 0) {
    return emptyMetricResult([
      'No OCI metric definitions configured in cloud connection metadata key ociMetricDefinitions.',
    ], {
      metricDefinitions: 0,
      supportedNamespaces: ['oci_computeagent', 'oci_vmi_resource_utilization'],
    });
  }

  const client = dependencies.createClient(job);
  const collection = resolveOciCollectionWindow(job);
  const requestRange = resolveOciRequestRange(job);
  const tasks = buildOciCollectionTasks(definitions, collection.interval, {
    subtreeCompartmentId: job.connection.rootExternalId,
  });
  const clientsByRegion = new Map<string, OciMonitoringClient>();
  let apiCallCount = 0;

  // The initial client is kept for the common single-region path. Additional
  // clients are created lazily when a confirmed definition belongs to another
  // OCI region; this prevents querying Phoenix metrics through an Ashburn
  // endpoint while still reusing one client per region per job.
  clientsByRegion.set(regionKey(job), client);

  try {
    const samplesByTask = await mapWithConcurrency(tasks, 4, async (task) => {
      const definition = task.definition;
      const statistic = task.statistic;
      const taskRegion = definition.regionId ?? regionKey(job);
      const taskJob = taskRegion === regionKey(job)
        ? job
        : { ...job, requestContext: { ...(job.requestContext ?? {}), regionId: taskRegion } };
      const taskClient = getOrCreateRegionalClient(taskJob, taskRegion, dependencies, clientsByRegion);
      const query = task.query;
        const request = (compartmentId: string, compartmentIdInSubtree = false) => dependencies.withRetry(() => taskClient.summarizeMetricsData({
          compartmentId,
          ...(compartmentIdInSubtree ? { compartmentIdInSubtree: true } : {}),
          summarizeMetricsDataDetails: {
          namespace: definition.namespace,
          query,
          startTime: requestRange.startTime,
          endTime: requestRange.endTime,
          resolution: collection.interval,
        },
        }));
      const execute = async (compartmentId: string, compartmentIdInSubtree = false) => {
        apiCallCount += 1;
        const operation = () => request(compartmentId, compartmentIdInSubtree);
        return dependencies.withRateLimit === undefined
          ? operation()
          : dependencies.withRateLimit(taskJob, operation);
      };
      let response;
      try {
        response = await execute(
          task.queryCompartmentId ?? definition.compartmentId,
          task.compartmentIdInSubtree === true,
        );
      } catch (error) {
        if (!shouldFallbackFromSubtree(task, error)) throw error;
        const fallbackResponses = await mapWithConcurrency(task.fallbackCompartmentIds ?? [], 2, (compartmentId) => execute(compartmentId));
        response = {
          items: fallbackResponses.flatMap((item) => item.items ?? []),
          summarizedMetricsData: fallbackResponses.flatMap((item) => item.summarizedMetricsData ?? []),
        };
      }
      const taskSamples: NormalizedResourceMetricSample[] = [];
      for (const metric of response.items ?? response.summarizedMetricsData ?? []) {
        const dimensions = normalizeDimensions(metric.dimensions ?? definition.dimensions);
        const externalResourceId = dimensions?.['resourceId'] ?? dimensions?.['resource_id'] ?? definition.resourceId;
        if (task.allowedResourceIds !== undefined
          && (externalResourceId === undefined || !task.allowedResourceIds.has(externalResourceId))) {
          continue;
        }
        const regionId = definition.regionId ?? dimensions?.['regionId'] ?? dimensions?.['region'];
        for (const point of metric.aggregatedDatapoints ?? []) {
          if (point.timestamp === undefined || point.value === undefined) continue;
          taskSamples.push({
            tenantId: job.tenantId,
            cloudConnectionId: job.cloudConnectionId,
            provider: 'OCI',
            externalResourceId,
            providerNamespace: metric.namespace ?? definition.namespace,
            ...(regionId !== undefined ? { regionId } : {}),
            compartmentId: definition.compartmentId,
            ...(dimensions !== undefined ? { dimensions, dimensionsHash: hashDimensions(dimensions) } : {}),
            metricName: metric.name ?? definition.metricName,
            statistic,
            value: point.value,
            sampledAt: point.timestamp instanceof Date ? point.timestamp : new Date(point.timestamp),
            granularitySeconds: collection.granularitySeconds,
            ...(definition.unit !== undefined ? { metricUnit: definition.unit } : {}),
            rawMetric: {
              namespace: metric.namespace ?? definition.namespace,
              query,
              statistic,
              interval: collection.interval,
              resolution: collection.interval,
              compartmentId: definition.compartmentId,
              ...(regionId !== undefined ? { regionId } : {}),
              ...(dimensions !== undefined ? { dimensions } : {}),
            },
          });
        }
      }
      return taskSamples;
    });
    const samples = samplesByTask.flat();

    return buildMetricResult(collection, requestRange, definitions.length, apiCallCount, samples);
  } finally {
    for (const regionalClient of clientsByRegion.values()) regionalClient.close?.();
  }
}

function shouldFallbackFromSubtree(task: OciCollectionTask, error: unknown): boolean {
  if (task.compartmentIdInSubtree !== true || (task.fallbackCompartmentIds?.length ?? 0) === 0) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /403|forbidden|not.?authorized|authorization|subtree|compartment.*permission|permission/i.test(message);
}

function normalizeDimensions(
  dimensions: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (dimensions === undefined) return undefined;
  const normalized = { ...dimensions };
  for (const key of ['resourceId', 'resource_id']) {
    const canonical = normalizeExternalResourceId(normalized[key]);
    if (canonical !== undefined) normalized[key] = canonical;
  }
  return normalized;
}

function buildMetricResult(
  collection: { readonly interval: '1m' | '5m' | '30m' | '1h'; readonly granularitySeconds: 60 | 300 | 1800 | 3600 },
  requestRange: { readonly startTime: Date; readonly endTime: Date },
  definitionCount: number,
  apiCallCount: number,
  samples: readonly NormalizedResourceMetricSample[],
): CloudIngestionResult {
  return {
    apiCallCount,
    objectsProcessed: 0,
    focusRows: [],
    resources: [],
    metricSamples: samples,
    warnings: samples.length === 0
      ? ['OCI Monitoring returned no datapoints for the configured metric definitions.']
      : [],
    coverage: {
      requestedStart: requestRange.startTime.toISOString(),
      requestedEnd: requestRange.endTime.toISOString(),
      interval: collection.interval,
      granularitySeconds: collection.granularitySeconds,
      datapointsReturned: samples.length,
      metricDefinitions: definitionCount,
      samples: samples.length,
      statistics: summarizeStatistics(samples),
      memoryRequiresComputeAgent: true,
      agentlessCpuNamespace: 'oci_vmi_resource_utilization',
    },
  };
}

function summarizeStatistics(
  samples: readonly NormalizedResourceMetricSample[],
): Readonly<Record<string, number>> {
  return samples.reduce<Record<string, number>>((counts, sample) => {
    const statistic = sample.statistic ?? 'MEAN';
    counts[statistic] = (counts[statistic] ?? 0) + 1;
    return counts;
  }, {});
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function getOrCreateRegionalClient(
  job: CloudIngestionJobContext,
  regionId: string,
  dependencies: OciMonitoringDependencies,
  clientsByRegion: Map<string, OciMonitoringClient>,
): OciMonitoringClient {
  const existing = clientsByRegion.get(regionId);
  if (existing !== undefined) return existing;
  const created = dependencies.createClient(job);
  clientsByRegion.set(regionId, created);
  return created;
}

function regionKey(job: Pick<CloudIngestionJobContext, 'connection' | 'requestContext'>): string {
  const requestRegion = optionalString(job.requestContext?.['regionId']);
  return requestRegion ?? job.connection.defaultRegion ?? 'default';
}

export function readOciMetricDefinitions(
  job: CloudIngestionJobContext,
): readonly OciMetricDefinition[] {
  return readObjectArray(job.connection.metadata, 'ociMetricDefinitions').map((item) => {
    const query = optionalString(item['query']);
    const unit = optionalString(item['unit']);
    const regionId = optionalString(item['regionId']);
    const configuredStatistics = readStringArray(item['statistics']);
    const singularStatistic = optionalString(item['statistic']);
    const statistics = configuredStatistics.length > 0
      ? configuredStatistics.map((value) => parseMetricStatistic(value, 'ociMetricDefinitions.statistics'))
      : singularStatistic === undefined
        ? ['MEAN' as const]
        : [parseMetricStatistic(singularStatistic, 'ociMetricDefinitions.statistic')];
    if (query !== undefined && statistics.length > 1) {
      throw new Error('ociMetricDefinitions.query cannot be combined with multiple statistics');
    }
    if (query !== undefined && !queryContainsStatistic(query, statistics[0]!)) {
      throw new Error('ociMetricDefinitions.query does not match its configured statistic');
    }
    const resourceId = normalizeExternalResourceId(
      optionalString(item['resourceId'])
        ?? readStringArray(item['resourceIds'])[0]
        ?? job.connection.rootExternalId,
    ) ?? job.connection.rootExternalId;
    return {
      compartmentId: requireString(item['compartmentId'], 'ociMetricDefinitions.compartmentId'),
      namespace: optionalString(item['namespace']) ?? 'oci_computeagent',
      metricName: requireString(item['metricName'], 'ociMetricDefinitions.metricName'),
      resourceId,
      ...(regionId !== undefined ? { regionId } : {}),
      ...(isStringRecord(item['dimensions']) ? { dimensions: item['dimensions'] } : {}),
      ...(query !== undefined ? { query } : {}),
      statistics,
      ...(unit !== undefined ? { unit } : {}),
    };
  });
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

export function resolveOciCollectionWindow(job: Pick<CloudIngestionJobContext, 'targetStart' | 'targetEnd' | 'requestContext'>): {
  readonly interval: '1m' | '5m' | '30m' | '1h';
  readonly granularitySeconds: 60 | 300 | 1800 | 3600;
} {
  const configured = job.requestContext?.['interval'];
  if (configured === '1m' || configured === '5m' || configured === '30m' || configured === '1h') {
    return {
      interval: configured,
      granularitySeconds: configured === '1m' ? 60 : configured === '5m' ? 300 : configured === '30m' ? 1800 : 3600,
    };
  }

  const spanMs = job.targetEnd.getTime() - job.targetStart.getTime();
  return spanMs > 30 * 24 * 60 * 60 * 1000
    ? { interval: '1h', granularitySeconds: 3600 }
    : { interval: '30m', granularitySeconds: 1800 };
}

function hashDimensions(dimensions: Readonly<Record<string, string>>): string {
  const canonical = Object.keys(dimensions).sort().map((key) => `${key}=${dimensions[key]}`).join('&');
  return createHash('sha256').update(canonical).digest('hex');
}

/** OCI rejects a request as soon as its start crosses the rolling 90-day limit. */
export function resolveOciRequestRange(job: Pick<CloudIngestionJobContext, 'targetStart' | 'targetEnd'>, now = new Date()): {
  readonly startTime: Date;
  readonly endTime: Date;
} {
  const retentionMs = 90 * 24 * 60 * 60 * 1000;
  const safetyMarginMs = 15 * 60 * 1000;
  const earliestAllowed = new Date(now.getTime() - retentionMs + safetyMarginMs);
  const startTime = job.targetStart > earliestAllowed ? job.targetStart : earliestAllowed;
  const endTime = job.targetEnd < now ? job.targetEnd : now;
  if (endTime <= startTime) {
    throw new Error('OCI metric job is outside the provider 90-day retention window.');
  }
  return { startTime, endTime };
}

function parseMetricStatistic(value: string, field: string): MetricStatistic {
  const normalized = value.trim().toUpperCase();
  if (!(METRIC_STATISTICS as readonly string[]).includes(normalized)) {
    throw new Error(`${field} must contain a supported metric statistic`);
  }
  return normalized as MetricStatistic;
}

function queryContainsStatistic(query: string, statistic: MetricStatistic): boolean {
  const normalized = query.toLowerCase().replace(/\s+/g, '');
  if (statistic === 'P50') return normalized.includes('percentile(0.5)') || normalized.includes('percentile(.5)');
  if (statistic === 'P90') return normalized.includes('percentile(0.9)') || normalized.includes('percentile(.9)');
  if (statistic === 'P95') return normalized.includes('percentile(0.95)') || normalized.includes('percentile(.95)');
  if (statistic === 'P99') return normalized.includes('percentile(0.99)') || normalized.includes('percentile(.99)');
  return normalized.includes(`${statistic.toLowerCase()}()`);
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

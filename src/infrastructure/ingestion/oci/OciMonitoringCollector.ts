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
import { getOrCreateRegionalClient, mapWithConcurrency, regionKey } from './OciMonitoringCollectionSupport.js';
export { buildOciGroupedMetricQuery, buildOciResourceMetricQuery } from './OciMonitoringQueryBuilder.js';

const MAX_PERSIST_BATCH_SIZE = 5_000;

export interface OciMonitoringDependencies {
  readonly createClient: (job: CloudIngestionJobContext, signal?: AbortSignal) => OciMonitoringClient;
  readonly withRetry: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  readonly withRateLimit?: <T>(job: CloudIngestionJobContext, operation: () => Promise<T>) => Promise<T>;
}

export async function collectOciTechnicalMetrics(
  job: CloudIngestionJobContext,
  dependencies: OciMonitoringDependencies,
  options: { readonly signal?: AbortSignal; readonly isCancellationRequested?: () => Promise<boolean> } = {},
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

  const collection = resolveOciCollectionWindow(job);
  const requestRange = resolveOciRequestRange(job);
  const tasks = buildOciCollectionTasks(definitions, collection.interval, {
    subtreeCompartmentId: job.connection.rootExternalId,
  });
  const stats = { apiCallCount: 0, sampleCount: 0, statistics: {} as Record<string, number> };
  const coverage: Record<string, unknown> = {
    requestedStart: requestRange.startTime.toISOString(),
    requestedEnd: requestRange.endTime.toISOString(),
    interval: collection.interval,
    granularitySeconds: collection.granularitySeconds,
    datapointsReturned: 0,
    metricDefinitions: definitions.length,
    samples: 0,
    statistics: stats.statistics,
    memoryRequiresComputeAgent: true,
    agentlessCpuNamespace: 'oci_vmi_resource_utilization',
  };
  const warnings: string[] = [];
  const metricBatches = streamOciMetricBatches(job, dependencies, tasks, collection, requestRange, stats, coverage, warnings, options);

  return {
    get apiCallCount() { return stats.apiCallCount; },
    objectsProcessed: 0,
    focusRows: [],
    resources: [],
    metricSamples: [],
    metricBatches,
    warnings,
    coverage,
  };
}

async function* streamOciMetricBatches(
  job: CloudIngestionJobContext,
  dependencies: OciMonitoringDependencies,
  tasks: readonly OciCollectionTask[],
  collection: { readonly interval: '1m' | '5m' | '30m' | '1h'; readonly granularitySeconds: 60 | 300 | 1800 | 3600 },
  requestRange: { readonly startTime: Date; readonly endTime: Date },
  stats: { apiCallCount: number; sampleCount: number; statistics: Record<string, number> },
  coverage: Record<string, unknown>,
  warnings: string[],
  options: { readonly signal?: AbortSignal; readonly isCancellationRequested?: () => Promise<boolean> },
): AsyncGenerator<readonly NormalizedResourceMetricSample[]> {
  const clientsByRegion = new Map<string, OciMonitoringClient>();
  const queue: NormalizedResourceMetricSample[][] = [];
  let done = false;
  let cancelled = false;
  let producerError: unknown;
  let wakeConsumer: (() => void) | undefined;
  const producerWaiters: (() => void)[] = [];
  const wait = (setter: (resolve: () => void) => void): Promise<void> => new Promise((resolve) => setter(resolve));
  const enqueueQueue = async (batch: NormalizedResourceMetricSample[]): Promise<void> => {
    while (!cancelled && queue.length >= 8) await wait((resolve) => { producerWaiters.push(resolve); });
    if (cancelled || batch.length === 0) return;
    queue.push(batch);
    wakeConsumer?.();
    wakeConsumer = undefined;
  };
  let pendingBatch: NormalizedResourceMetricSample[] = [];
  const enqueue = async (batch: NormalizedResourceMetricSample[]): Promise<void> => {
    for (const sample of batch) {
      pendingBatch.push(sample);
      if (pendingBatch.length >= MAX_PERSIST_BATCH_SIZE) {
        const fullBatch = pendingBatch;
        pendingBatch = [];
        await enqueueQueue(fullBatch);
      }
    }
  };
  const producer = mapWithConcurrency(tasks, 4, async (task) => {
    await collectOciTask(task, job, dependencies, collection, requestRange, clientsByRegion, stats, enqueue, options);
  }).then(() => {
    return enqueueQueue(pendingBatch).then(() => {
      pendingBatch = [];
      done = true;
      wakeConsumer?.();
      wakeConsumer = undefined;
    });
  }).catch((error: unknown) => {
    producerError = error;
    done = true;
    wakeConsumer?.();
    wakeConsumer = undefined;
  });

  try {
    while (!done || queue.length > 0) {
      await assertCollectorActive(options);
      if (queue.length === 0) await wait((resolve) => { wakeConsumer = resolve; });
      while (queue.length > 0) {
        await assertCollectorActive(options);
        const batch = queue.shift();
        if (batch === undefined) continue;
        yield batch;
        producerWaiters.shift()?.();
      }
    }
    await producer;
    if (producerError !== undefined) throw producerError;
    coverage.datapointsReturned = stats.sampleCount;
    coverage.samples = stats.sampleCount;
    if (stats.sampleCount === 0) warnings.push('OCI Monitoring no devolvió muestras para las definiciones configuradas y el periodo solicitado.');
  } finally {
    cancelled = true;
    for (const wakeProducer of producerWaiters.splice(0)) wakeProducer();
    wakeConsumer?.();
    await producer.catch(() => undefined);
    for (const regionalClient of clientsByRegion.values()) regionalClient.close?.();
  }
}

async function collectOciTask(
  task: OciCollectionTask,
  job: CloudIngestionJobContext,
  dependencies: OciMonitoringDependencies,
  collection: { readonly interval: '1m' | '5m' | '30m' | '1h'; readonly granularitySeconds: 60 | 300 | 1800 | 3600 },
  requestRange: { readonly startTime: Date; readonly endTime: Date },
  clientsByRegion: Map<string, OciMonitoringClient>,
  stats: { apiCallCount: number; sampleCount: number; statistics: Record<string, number> },
  enqueue: (batch: NormalizedResourceMetricSample[]) => Promise<void>,
  options: { readonly signal?: AbortSignal; readonly isCancellationRequested?: () => Promise<boolean> },
): Promise<void> {
  await assertCollectorActive(options);
  const definition = task.definition;
  const statistic = task.statistic;
  const taskRegion = definition.regionId ?? regionKey(job);
  const taskJob = taskRegion === regionKey(job)
    ? job
    : { ...job, requestContext: { ...(job.requestContext ?? {}), regionId: taskRegion } };
  const taskClient = getOrCreateRegionalClient(taskJob, taskRegion, dependencies.createClient, clientsByRegion, options.signal);
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
  }), options.signal);
  const execute = async (compartmentId: string, compartmentIdInSubtree = false) => {
    stats.apiCallCount += 1;
    const operation = () => request(compartmentId, compartmentIdInSubtree);
    return dependencies.withRateLimit === undefined ? operation() : dependencies.withRateLimit(taskJob, operation);
  };
  let response;
  try {
    response = await execute(task.queryCompartmentId ?? definition.compartmentId, task.compartmentIdInSubtree === true);
  } catch (error) {
    if (!shouldFallbackFromSubtree(task, error)) throw error;
    const fallbackResponses = await mapWithConcurrency(task.fallbackCompartmentIds ?? [], 2, (compartmentId) => execute(compartmentId));
    response = {
      items: fallbackResponses.flatMap((item) => item.items ?? []),
      summarizedMetricsData: fallbackResponses.flatMap((item) => item.summarizedMetricsData ?? []),
    };
  }
  let batch: NormalizedResourceMetricSample[] = [];
  for (const metric of response.items ?? response.summarizedMetricsData ?? []) {
    await assertCollectorActive(options);
    const dimensions = normalizeDimensions(metric.dimensions ?? definition.dimensions);
    const externalResourceId = dimensions?.['resourceId'] ?? dimensions?.['resource_id'] ?? definition.resourceId;
    if (task.allowedResourceIds !== undefined && (externalResourceId === undefined || !task.allowedResourceIds.has(externalResourceId))) continue;
    const regionId = definition.regionId ?? dimensions?.['regionId'] ?? dimensions?.['region'];
    for (const point of metric.aggregatedDatapoints ?? []) {
      if (point.timestamp === undefined || point.value === undefined) continue;
      batch.push({
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
      stats.sampleCount += 1;
      stats.statistics[statistic] = (stats.statistics[statistic] ?? 0) + 1;
      if (batch.length >= MAX_PERSIST_BATCH_SIZE) {
        await enqueue(batch);
        batch = [];
      }
    }
  }
  if (batch.length > 0) await enqueue(batch);
}

async function assertCollectorActive(options: { readonly signal?: AbortSignal; readonly isCancellationRequested?: () => Promise<boolean> }): Promise<void> {
  if (options.signal?.aborted === true) throw new Error('OCI metric collection cancelled');
  if (options.isCancellationRequested !== undefined && await options.isCancellationRequested()) {
    throw new Error('OCI metric collection cancelled');
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

import { METRIC_STATISTICS, type MetricStatistic } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import { normalizeExternalResourceId } from '../../../domain/models/ResourceLinkage.js';
import type { OciMetricDefinition } from './OciSdkContracts.js';

export interface OciMetricFilter {
  readonly namespace?: string;
  readonly metricName?: string;
  readonly resourceId?: string;
  readonly regionId?: string;
  readonly statistic?: MetricStatistic;
}

export function readOciMetricFilter(
  requestContext: Readonly<Record<string, unknown>> | undefined,
): OciMetricFilter | undefined {
  const raw = requestContext?.['metricFilter'];
  if (raw === undefined) return undefined;
  if (!isStringRecord(raw)) throw new Error('requestContext.metricFilter debe ser un objeto de texto.');
  const filter: OciMetricFilter = {
    ...(raw['namespace'] !== undefined ? { namespace: requireFilterValue(raw['namespace'], 'namespace') } : {}),
    ...(raw['metricName'] !== undefined ? { metricName: requireFilterValue(raw['metricName'], 'metricName') } : {}),
    ...(raw['resourceId'] !== undefined ? { resourceId: requireFilterValue(raw['resourceId'], 'resourceId') } : {}),
    ...(raw['regionId'] !== undefined ? { regionId: requireFilterValue(raw['regionId'], 'regionId') } : {}),
    ...(raw['statistic'] !== undefined
      ? { statistic: parseMetricStatistic(requireFilterValue(raw['statistic'], 'statistic'), 'requestContext.metricFilter.statistic') }
      : {}),
  };
  if (Object.keys(filter).length === 0) throw new Error('requestContext.metricFilter debe contener al menos un filtro.');
  return filter;
}

export function filterOciMetricDefinitions(
  definitions: readonly OciMetricDefinition[],
  filter: OciMetricFilter | undefined,
): readonly OciMetricDefinition[] {
  if (filter === undefined) return definitions;
  return definitions.flatMap((definition) => {
    if (filter.namespace !== undefined && definition.namespace !== filter.namespace) return [];
    if (filter.metricName !== undefined && definition.metricName !== filter.metricName) return [];
    if (filter.resourceId !== undefined && normalizeExternalResourceId(definition.resourceId) !== normalizeExternalResourceId(filter.resourceId)) return [];
    if (filter.regionId !== undefined && definition.regionId !== filter.regionId) return [];
    if (filter.statistic === undefined) return [definition];
    if (definition.query !== undefined && !queryContainsStatistic(definition.query, filter.statistic)) return [];
    return [{ ...definition, statistics: [filter.statistic] }];
  });
}

export function parseMetricStatistic(value: string, field: string): MetricStatistic {
  const normalized = value.trim().toUpperCase();
  if (!(METRIC_STATISTICS as readonly string[]).includes(normalized)) {
    throw new Error(`${field} must contain a supported metric statistic`);
  }
  return normalized as MetricStatistic;
}

export function queryContainsStatistic(query: string, statistic: MetricStatistic): boolean {
  const normalized = query.toLowerCase().replace(/\s+/g, '');
  if (statistic === 'P50') return normalized.includes('percentile(0.5)') || normalized.includes('percentile(.5)');
  if (statistic === 'P90') return normalized.includes('percentile(0.9)') || normalized.includes('percentile(.9)');
  if (statistic === 'P95') return normalized.includes('percentile(0.95)') || normalized.includes('percentile(.95)');
  if (statistic === 'P99') return normalized.includes('percentile(0.99)') || normalized.includes('percentile(.99)');
  return normalized.includes(`${statistic.toLowerCase()}()`);
}

function requireFilterValue(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`requestContext.metricFilter.${field} no puede estar vacío.`);
  return normalized;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string');
}

import type {
  TechnicalMetricSeriesFilters,
  TechnicalMetricSeriesRepositoryPoint,
  TechnicalMetricSummaryFilters,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import type { MetricStatistic } from '../../domain/interfaces/ICloudIngestionProvider.js';
import { Prisma } from '../../generated/prisma/client.js';

export interface RawMetricSeriesRow {
  readonly bucket_start: Date;
  readonly external_resource_id: string;
  readonly cloud_resource_id: string | null;
  readonly provider_namespace?: string;
  readonly region_id?: string;
  readonly dimensions_hash?: string;
  readonly metric_name: string;
  readonly metric_unit: string | null;
  readonly statistic: string;
  readonly granularity_seconds?: number;
  readonly selected_value?: number;
  readonly aggregation_semantics?: string;
  readonly source_granularities?: number[];
  readonly avg_value: number;
  readonly sum_value?: number;
  readonly min_value: number;
  readonly max_value: number;
  readonly latest_value: number;
  readonly sample_count: number;
  readonly min_sampled_at: Date | null;
  readonly max_sampled_at: Date | null;
  readonly latest_sampled_at: Date | null;
}

export interface RawMetricSummaryRow {
  readonly provider: string;
  readonly external_resource_id: string;
  readonly cloud_resource_id: string | null;
  readonly cloud_connection_id: string | null;
  readonly provider_namespace?: string;
  readonly region_id?: string;
  readonly dimensions_hash?: string;
  readonly resource_type: string | null;
  readonly service_name: string | null;
  readonly metric_name: string;
  readonly metric_unit: string | null;
  readonly statistic: string;
  readonly sample_count: number;
  readonly coverage_days: number;
  readonly min_value: number;
  readonly max_value: number;
  readonly avg_value: number;
  readonly p50_value: number;
  readonly p95_value: number;
  readonly p99_value: number;
  readonly latest_value: number;
  readonly high_utilization_sample_count: number | null;
  readonly high_utilization_ratio: number | null;
  readonly first_sampled_at: Date;
  readonly latest_sampled_at: Date;
}

export interface MetricSeriesCursor {
  readonly kind: 'compound' | 'legacy-date';
  readonly bucketStart: Date;
  readonly externalResourceId: string;
  readonly cloudResourceId: string;
  readonly providerNamespace: string;
  readonly regionId: string;
  readonly metricName: string;
  readonly dimensionsHash: string;
  readonly granularitySeconds: number;
}

export interface MetricWhereFilters {
  readonly startDate?: Date;
  readonly endDate?: Date;
  readonly externalResourceId?: string;
  readonly cloudResourceId?: string;
  readonly metricNames?: readonly string[];
  readonly statistic?: MetricStatistic;
  readonly cursor?: string;
}

export function buildMetricSeriesCursor(row: RawMetricSeriesRow | undefined): string | undefined {
  if (row === undefined) {
    return undefined;
  }

  return [
    row.bucket_start.toISOString(),
    row.external_resource_id,
    row.cloud_resource_id ?? '',
    row.provider_namespace ?? '',
    row.region_id ?? '',
    row.metric_name,
    row.dimensions_hash ?? '',
    String(row.granularity_seconds ?? 0),
  ].map((part) => encodeURIComponent(part)).join('|');
}

export function parseMetricSeriesCursor(cursor: string | undefined): MetricSeriesCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  const parts = cursor.split('|');
  if (parts.length !== 8 && parts.length !== 4 && parts.length !== 3) {
    return parseLegacyDateCursor(cursor);
  }

  const [rawBucketStart, rawExternalResourceId, rawCloudResourceId, rawProviderNamespace, rawRegionId, rawMetricName, rawDimensionsHash, rawGranularitySeconds] = parts.length === 8
    ? parts
    : parts.length === 4
      ? [parts[0], parts[1], parts[2], '', '', parts[3], '', '0']
      : [parts[0], parts[1], '', '', '', parts[2], '', '0'];
  if (
    rawBucketStart === undefined ||
    rawExternalResourceId === undefined ||
    rawCloudResourceId === undefined ||
    rawProviderNamespace === undefined ||
    rawRegionId === undefined ||
    rawMetricName === undefined
  ) {
    return undefined;
  }

  const bucketStart = new Date(decodeURIComponent(rawBucketStart));
  const externalResourceId = decodeURIComponent(rawExternalResourceId);
  const cloudResourceId = decodeURIComponent(rawCloudResourceId);
  const providerNamespace = decodeURIComponent(rawProviderNamespace);
  const regionId = decodeURIComponent(rawRegionId);
  const metricName = decodeURIComponent(rawMetricName);
  const dimensionsHash = decodeURIComponent(rawDimensionsHash ?? '');
  const granularitySeconds = Number(decodeURIComponent(rawGranularitySeconds ?? '0'));

  if (
    Number.isNaN(bucketStart.getTime()) ||
    externalResourceId.trim() === '' ||
    metricName.trim() === ''
  ) {
    return undefined;
  }

  return {
    kind: 'compound',
    bucketStart,
    externalResourceId,
    cloudResourceId,
    providerNamespace,
    regionId,
    metricName,
    dimensionsHash,
    granularitySeconds: Number.isFinite(granularitySeconds) ? granularitySeconds : 0,
  };
}

function parseLegacyDateCursor(cursor: string): MetricSeriesCursor | undefined {
  const bucketStart = new Date(cursor);
  if (Number.isNaN(bucketStart.getTime())) {
    return undefined;
  }

  return {
    kind: 'legacy-date',
    bucketStart,
    externalResourceId: '',
    cloudResourceId: '',
    providerNamespace: '',
    regionId: '',
    metricName: '',
    dimensionsHash: '',
    granularitySeconds: 0,
  };
}

export function buildMetricWhereClause(
  tenantId: string,
  filters: MetricWhereFilters,
  includeCursor: boolean,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`tenant_id = ${tenantId}`];

  if (filters.startDate !== undefined) {
    clauses.push(Prisma.sql`sampled_at >= ${filters.startDate}`);
  }
  if (filters.endDate !== undefined) {
    clauses.push(Prisma.sql`sampled_at <= ${filters.endDate}`);
  }
  if (filters.externalResourceId !== undefined) {
    clauses.push(Prisma.sql`external_resource_id = ${filters.externalResourceId}`);
  }
  if (filters.cloudResourceId !== undefined) {
    clauses.push(Prisma.sql`cloud_resource_id = ${filters.cloudResourceId}`);
  }
  if (filters.metricNames !== undefined && filters.metricNames.length > 0) {
    clauses.push(Prisma.sql`metric_name IN (${Prisma.join([...filters.metricNames])})`);
  }
  clauses.push(Prisma.sql`statistic = ${(filters.statistic ?? 'MEAN')}::"MetricStatistic"`);
  if (includeCursor && filters.cursor !== undefined) {
    clauses.push(Prisma.sql`sampled_at > ${filters.cursor}`);
  }

  return Prisma.join(clauses, ' AND ');
}

export function buildMetricRollupWhereClause(
  tenantId: string,
  filters: MetricWhereFilters,
  bucketSeconds: number,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`tenant_id = ${tenantId}`, Prisma.sql`bucket_seconds = ${bucketSeconds}`];
  if (filters.startDate !== undefined) clauses.push(Prisma.sql`bucket_start >= ${filters.startDate}`);
  if (filters.endDate !== undefined) clauses.push(Prisma.sql`bucket_start <= ${filters.endDate}`);
  if (filters.externalResourceId !== undefined) clauses.push(Prisma.sql`external_resource_id = ${filters.externalResourceId}`);
  if (filters.cloudResourceId !== undefined) clauses.push(Prisma.sql`cloud_resource_id = ${filters.cloudResourceId}`);
  if (filters.metricNames !== undefined && filters.metricNames.length > 0) {
    clauses.push(Prisma.sql`metric_name IN (${Prisma.join([...filters.metricNames])})`);
  }
  clauses.push(Prisma.sql`statistic = ${(filters.statistic ?? 'MEAN')}::"MetricStatistic"`);
  return Prisma.join(clauses, ' AND ');
}

export function buildBucketExpression(bucket: TechnicalMetricSeriesFilters['bucket']): Prisma.Sql {
  if (bucket === 'raw') {
    return Prisma.sql`sampled_at`;
  }
  if (bucket === '30m') {
    return Prisma.sql`to_timestamp(floor(extract(epoch from sampled_at) / 1800) * 1800)`;
  }
  if (bucket === 'hour') {
    return Prisma.sql`date_trunc('hour', sampled_at)`;
  }

  return Prisma.sql`date_trunc('day', sampled_at)`;
}

export function buildMetricSummaryWhereClause(
  tenantId: string,
  filters: TechnicalMetricSummaryFilters,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`tenant_id = ${tenantId}`];

  if (filters.startDate !== undefined) {
    clauses.push(Prisma.sql`sampled_at >= ${filters.startDate}`);
  }
  if (filters.endDate !== undefined) {
    clauses.push(Prisma.sql`sampled_at <= ${filters.endDate}`);
  }
  if (filters.externalResourceIds !== undefined && filters.externalResourceIds.length > 0) {
    clauses.push(Prisma.sql`external_resource_id IN (${Prisma.join([...filters.externalResourceIds])})`);
  }
  if (filters.cloudResourceIds !== undefined && filters.cloudResourceIds.length > 0) {
    clauses.push(Prisma.sql`cloud_resource_id IN (${Prisma.join([...filters.cloudResourceIds])})`);
  }
  if (filters.metricNames !== undefined && filters.metricNames.length > 0) {
    clauses.push(Prisma.sql`metric_name IN (${Prisma.join([...filters.metricNames])})`);
  }
  clauses.push(Prisma.sql`statistic = ${(filters.statistic ?? 'MEAN')}::"MetricStatistic"`);

  return Prisma.join(clauses, ' AND ');
}

export function buildAliasedMetricSummaryWhereClause(
  tenantId: string,
  filters: TechnicalMetricSummaryFilters,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`rms.tenant_id = ${tenantId}`];

  if (filters.startDate !== undefined) {
    clauses.push(Prisma.sql`rms.sampled_at >= ${filters.startDate}`);
  }
  if (filters.endDate !== undefined) {
    clauses.push(Prisma.sql`rms.sampled_at <= ${filters.endDate}`);
  }
  if (filters.externalResourceIds !== undefined && filters.externalResourceIds.length > 0) {
    clauses.push(Prisma.sql`rms.external_resource_id IN (${Prisma.join([...filters.externalResourceIds])})`);
  }
  if (filters.cloudResourceIds !== undefined && filters.cloudResourceIds.length > 0) {
    clauses.push(Prisma.sql`rms.cloud_resource_id IN (${Prisma.join([...filters.cloudResourceIds])})`);
  }
  if (filters.metricNames !== undefined && filters.metricNames.length > 0) {
    clauses.push(Prisma.sql`rms.metric_name IN (${Prisma.join([...filters.metricNames])})`);
  }
  clauses.push(Prisma.sql`rms.statistic = ${(filters.statistic ?? 'MEAN')}::"MetricStatistic"`);

  return Prisma.join(clauses, ' AND ');
}

export function mapMetricSeriesRow(row: RawMetricSeriesRow): TechnicalMetricSeriesRepositoryPoint {
  const selectedValue = row.selected_value ?? row.avg_value;
  return {
    bucketStart: row.bucket_start,
    externalResourceId: row.external_resource_id,
    ...(row.cloud_resource_id !== null ? { cloudResourceId: row.cloud_resource_id } : {}),
    ...((row.provider_namespace ?? '') !== '' ? { providerNamespace: row.provider_namespace } : {}),
    ...((row.region_id ?? '') !== '' ? { regionId: row.region_id } : {}),
    ...((row.dimensions_hash ?? '') !== '' ? { dimensionsHash: row.dimensions_hash } : {}),
    metricName: row.metric_name,
    ...(row.metric_unit !== null ? { metricUnit: row.metric_unit } : {}),
    statistic: (row.statistic ?? 'MEAN') as MetricStatistic,
    value: roundMetric(selectedValue),
    aggregationSemantics: row.aggregation_semantics ?? 'LEGACY_AGGREGATE',
    sourceGranularitiesSeconds: (row.source_granularities ?? []).map(Number),
    avg: roundMetric(row.avg_value),
    min: roundMetric(row.min_value),
    max: roundMetric(row.max_value),
    latest: roundMetric(row.latest_value),
    sampleCount: row.sample_count,
    ...(row.min_sampled_at !== null ? { minSampledAt: row.min_sampled_at } : {}),
    ...(row.max_sampled_at !== null ? { maxSampledAt: row.max_sampled_at } : {}),
    ...(row.latest_sampled_at !== null ? { latestSampledAt: row.latest_sampled_at } : {}),
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

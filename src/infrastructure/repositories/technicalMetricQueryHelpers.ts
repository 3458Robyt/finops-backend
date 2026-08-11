import type {
  TechnicalMetricSeriesFilters,
  TechnicalMetricSeriesRepositoryPoint,
  TechnicalMetricSummaryFilters,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import { Prisma } from '../../generated/prisma/client.js';

export interface RawMetricSeriesRow {
  readonly bucket_start: Date;
  readonly external_resource_id: string;
  readonly cloud_resource_id: string | null;
  readonly metric_name: string;
  readonly metric_unit: string | null;
  readonly avg_value: number;
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
  readonly resource_type: string | null;
  readonly service_name: string | null;
  readonly metric_name: string;
  readonly metric_unit: string | null;
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
  readonly metricName: string;
}

export interface MetricWhereFilters {
  readonly startDate?: Date;
  readonly endDate?: Date;
  readonly externalResourceId?: string;
  readonly cloudResourceId?: string;
  readonly metricNames?: readonly string[];
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
    row.metric_name,
  ].map((part) => encodeURIComponent(part)).join('|');
}

export function parseMetricSeriesCursor(cursor: string | undefined): MetricSeriesCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  const parts = cursor.split('|');
  if (parts.length !== 4 && parts.length !== 3) {
    return parseLegacyDateCursor(cursor);
  }

  const [rawBucketStart, rawExternalResourceId, rawCloudResourceId, rawMetricName] = parts.length === 4
    ? parts
    : [parts[0], parts[1], '', parts[2]];
  if (
    rawBucketStart === undefined ||
    rawExternalResourceId === undefined ||
    rawCloudResourceId === undefined ||
    rawMetricName === undefined
  ) {
    return undefined;
  }

  const bucketStart = new Date(decodeURIComponent(rawBucketStart));
  const externalResourceId = decodeURIComponent(rawExternalResourceId);
  const cloudResourceId = decodeURIComponent(rawCloudResourceId);
  const metricName = decodeURIComponent(rawMetricName);

  if (
    Number.isNaN(bucketStart.getTime()) ||
    externalResourceId.trim() === '' ||
    metricName.trim() === ''
  ) {
    return undefined;
  }

  return { kind: 'compound', bucketStart, externalResourceId, cloudResourceId, metricName };
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
    metricName: '',
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
  if (includeCursor && filters.cursor !== undefined) {
    clauses.push(Prisma.sql`sampled_at > ${filters.cursor}`);
  }

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

  return Prisma.join(clauses, ' AND ');
}

export function mapMetricSeriesRow(row: RawMetricSeriesRow): TechnicalMetricSeriesRepositoryPoint {
  return {
    bucketStart: row.bucket_start,
    externalResourceId: row.external_resource_id,
    ...(row.cloud_resource_id !== null ? { cloudResourceId: row.cloud_resource_id } : {}),
    metricName: row.metric_name,
    ...(row.metric_unit !== null ? { metricUnit: row.metric_unit } : {}),
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

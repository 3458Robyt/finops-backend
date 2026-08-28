import type {
  TechnicalMetricSummaryFilters,
  TechnicalMetricSummaryItem,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import type { MetricStatistic } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

interface RawFastSummaryRow {
  readonly provider: string;
  readonly external_resource_id: string;
  readonly cloud_resource_id: string | null;
  readonly cloud_connection_id: string | null;
  readonly provider_namespace: string | null;
  readonly region_id: string | null;
  readonly dimensions_hash: string | null;
  readonly resource_type: string | null;
  readonly service_name: string | null;
  readonly metric_name: string;
  readonly metric_unit: string | null;
  readonly statistic: string;
  readonly sample_count: bigint;
  readonly coverage_days: bigint;
  readonly min_value: number;
  readonly max_value: number;
  readonly avg_value: number;
  readonly p50_value: number;
  readonly p95_value: number;
  readonly p99_value: number;
  readonly latest_value: number;
  readonly first_sampled_at: Date;
  readonly latest_sampled_at: Date;
}

/**
 * Bounded overview projection backed by daily PostgreSQL rollups.
 *
 * Raw samples remain canonical for evidence, auditing, and drill-down. This
 * reader intentionally serves the interactive overview only; its weighted
 * average and peak values are mathematically composable across daily buckets.
 */
export class PrismaResourceMetricSummaryReader {
  constructor(private readonly prisma: PrismaClient) {}

  public async listFast(
    tenantId: string,
    filters: TechnicalMetricSummaryFilters,
  ): Promise<readonly TechnicalMetricSummaryItem[]> {
    const where = buildWhere(tenantId, filters);
    const rows = await this.prisma.$queryRaw<RawFastSummaryRow[]>(Prisma.sql`
      SELECT
        r.provider::text AS provider,
        r.external_resource_id,
        r.cloud_resource_id,
        r.cloud_connection_id,
        r.provider_namespace,
        r.region_id,
        r.dimensions_hash,
        max(cr.resource_type) AS resource_type,
        max(cr.service_name) AS service_name,
        r.metric_name,
        max(r.metric_unit) AS metric_unit,
        r.statistic::text AS statistic,
        sum(r.sample_count)::bigint AS sample_count,
        count(DISTINCT r.bucket_start)::bigint AS coverage_days,
        min(r.min_value)::float8 AS min_value,
        max(r.max_value)::float8 AS max_value,
        (sum(r.sum_value) / nullif(sum(r.sample_count), 0))::float8 AS avg_value,
        coalesce(avg(r.p50_value) FILTER (WHERE r.p50_value IS NOT NULL),
          (sum(r.sum_value) / nullif(sum(r.sample_count), 0)))::float8 AS p50_value,
        coalesce(avg(r.p95_value) FILTER (WHERE r.p95_value IS NOT NULL),
          (sum(r.sum_value) / nullif(sum(r.sample_count), 0)))::float8 AS p95_value,
        coalesce(avg(r.p99_value) FILTER (WHERE r.p99_value IS NOT NULL),
          (sum(r.sum_value) / nullif(sum(r.sample_count), 0)))::float8 AS p99_value,
        (array_agg(r.latest_value ORDER BY r.bucket_start DESC, r.latest_sampled_at DESC))[1]::float8 AS latest_value,
        min(r.min_sampled_at) AS first_sampled_at,
        max(r.latest_sampled_at) AS latest_sampled_at
      FROM resource_metric_rollups r
      LEFT JOIN cloud_resources cr ON cr.id = r.cloud_resource_id
      WHERE ${where}
      GROUP BY r.provider, r.external_resource_id, r.cloud_resource_id,
        r.cloud_connection_id, r.provider_namespace, r.region_id,
        r.dimensions_hash, r.metric_name, r.statistic
      ORDER BY sample_count DESC, r.external_resource_id ASC,
        r.cloud_resource_id ASC NULLS LAST, r.provider_namespace ASC,
        r.region_id ASC, r.metric_name ASC, r.dimensions_hash ASC
      LIMIT ${filters.limit}
    `);

    return rows.map(toSummaryItem);
  }
}

function buildWhere(
  tenantId: string,
  filters: TechnicalMetricSummaryFilters,
): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`r.tenant_id = ${tenantId}`,
    Prisma.sql`r.bucket_seconds = 86400`,
  ];
  if (filters.startDate !== undefined) clauses.push(Prisma.sql`r.bucket_start >= ${filters.startDate}`);
  if (filters.endDate !== undefined) clauses.push(Prisma.sql`r.bucket_start <= ${filters.endDate}`);
  if (filters.externalResourceIds !== undefined && filters.externalResourceIds.length > 0) {
    clauses.push(Prisma.sql`r.external_resource_id IN (${Prisma.join([...filters.externalResourceIds])})`);
  }
  if (filters.cloudResourceIds !== undefined && filters.cloudResourceIds.length > 0) {
    clauses.push(Prisma.sql`r.cloud_resource_id IN (${Prisma.join([...filters.cloudResourceIds])})`);
  }
  if (filters.metricNames !== undefined && filters.metricNames.length > 0) {
    clauses.push(Prisma.sql`r.metric_name IN (${Prisma.join([...filters.metricNames])})`);
  }
  clauses.push(Prisma.sql`r.statistic = ${(filters.statistic ?? 'MEAN')}::"MetricStatistic"`);
  return Prisma.join(clauses, ' AND ');
}

function toSummaryItem(row: RawFastSummaryRow): TechnicalMetricSummaryItem {
  return {
    provider: row.provider,
    externalResourceId: row.external_resource_id,
    ...(row.cloud_resource_id !== null ? { cloudResourceId: row.cloud_resource_id } : {}),
    ...(row.cloud_connection_id !== null ? { cloudConnectionId: row.cloud_connection_id } : {}),
    ...(row.provider_namespace !== null && row.provider_namespace !== ''
      ? { providerNamespace: row.provider_namespace }
      : {}),
    ...(row.region_id !== null && row.region_id !== '' ? { regionId: row.region_id } : {}),
    ...(row.dimensions_hash !== null && row.dimensions_hash !== ''
      ? { dimensionsHash: row.dimensions_hash }
      : {}),
    ...(row.resource_type !== null ? { resourceType: row.resource_type } : {}),
    ...(row.service_name !== null ? { serviceName: row.service_name } : {}),
    metricName: row.metric_name,
    ...(row.metric_unit !== null ? { metricUnit: row.metric_unit } : {}),
    statistic: row.statistic as MetricStatistic,
    sampleCount: Number(row.sample_count),
    coverageDays: Number(row.coverage_days),
    min: row.min_value,
    max: row.max_value,
    avg: row.avg_value,
    p50: row.p50_value,
    p95: row.p95_value,
    p99: row.p99_value,
    latest: row.latest_value,
    firstSampledAt: row.first_sampled_at,
    latestSampledAt: row.latest_sampled_at,
  };
}

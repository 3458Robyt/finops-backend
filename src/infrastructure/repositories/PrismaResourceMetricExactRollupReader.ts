import type { TechnicalMetricSeriesFilters } from '../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  buildMetricRollupWhereClause,
  type MetricSeriesCursor,
  type RawMetricSeriesRow,
} from './technicalMetricQueryHelpers.js';

/** Reads the finest persisted projection without mixed-resolution reconciliation. */
export class PrismaResourceMetricExactRollupReader {
  constructor(private readonly prisma: PrismaClient) {}

  public async listFor(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
    cursor: MetricSeriesCursor | undefined,
    limit: number,
  ): Promise<RawMetricSeriesRow[]> {
    const where = buildMetricRollupWhereClause(tenantId, filters, 1800);
    const cursorCondition = cursor === undefined
      ? Prisma.empty
      : cursor.kind === 'legacy-date'
        ? Prisma.sql`AND bucket_start > ${cursor.bucketStart}`
        : Prisma.sql`
          AND (
            bucket_start, external_resource_id, COALESCE(cloud_resource_id, ''),
            provider_namespace, region_id, metric_name, dimensions_hash, bucket_seconds
          ) > (
            ${cursor.bucketStart}, ${cursor.externalResourceId}, ${cursor.cloudResourceId},
            ${cursor.providerNamespace}, ${cursor.regionId}, ${cursor.metricName},
            ${cursor.dimensionsHash}, ${cursor.granularitySeconds}
          )
        `;

    return this.prisma.$queryRaw<RawMetricSeriesRow[]>(Prisma.sql`
      SELECT
        bucket_start,
        external_resource_id,
        cloud_resource_id,
        provider_namespace,
        region_id,
        dimensions_hash,
        metric_name,
        metric_unit,
        statistic::text AS statistic,
        bucket_seconds AS granularity_seconds,
        CASE statistic::text
          WHEN 'MIN' THEN min_value
          WHEN 'MAX' THEN max_value
          WHEN 'P50' THEN COALESCE(p50_value, sum_value / NULLIF(sample_count, 0))
          WHEN 'P90' THEN COALESCE(p90_value, sum_value / NULLIF(sample_count, 0))
          WHEN 'P95' THEN COALESCE(p95_value, sum_value / NULLIF(sample_count, 0))
          WHEN 'P99' THEN COALESCE(p99_value, sum_value / NULLIF(sample_count, 0))
          WHEN 'SUM' THEN sum_value
          WHEN 'COUNT' THEN sample_count::numeric
          WHEN 'LATEST' THEN latest_value
          ELSE sum_value / NULLIF(sample_count, 0)
        END::float8 AS selected_value,
        CASE WHEN statistic::text IN ('P50', 'P90', 'P95', 'P99')
          THEN 'POSTGRES_ROLLUP_DERIVED_STATISTIC_AVG'
          ELSE 'POSTGRES_ROLLUP_DERIVED_PEAK_AWARE'
        END::text AS aggregation_semantics,
        ARRAY[bucket_seconds]::int[] AS source_granularities,
        avg_value::float8 AS avg_value,
        sum_value::float8 AS sum_value,
        min_value::float8 AS min_value,
        max_value::float8 AS max_value,
        latest_value::float8 AS latest_value,
        sample_count::int AS sample_count,
        min_sampled_at,
        max_sampled_at,
        latest_sampled_at
      FROM resource_metric_rollups
      WHERE ${where}
      ${cursorCondition}
      ORDER BY bucket_start ASC, external_resource_id ASC, COALESCE(cloud_resource_id, '') ASC,
        provider_namespace ASC, region_id ASC, metric_name ASC, dimensions_hash ASC, bucket_seconds ASC
      LIMIT ${limit}
    `);
  }

  public async countFor(tenantId: string, filters: TechnicalMetricSeriesFilters): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ readonly total: string | number | bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM(sample_count), 0)::bigint AS total
      FROM resource_metric_rollups
      WHERE ${buildMetricRollupWhereClause(tenantId, filters, 1800)}
    `);
    return Number(rows[0]?.total ?? 0);
  }
}

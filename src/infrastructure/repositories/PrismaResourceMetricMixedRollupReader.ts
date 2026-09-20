import type {
  TechnicalMetricSeriesFilters,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  buildMetricRollupWhereClause,
  type MetricSeriesCursor,
  type RawMetricSeriesRow,
} from './technicalMetricQueryHelpers.js';

/** Combines 30m/hour/day projections when a target bucket has mixed sources. */
export class PrismaResourceMetricMixedRollupReader {
  constructor(private readonly prisma: PrismaClient) {}

  public async listFor(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
    bucketSeconds: number,
    cursor: MetricSeriesCursor | undefined,
    limit: number,
  ): Promise<RawMetricSeriesRow[]> {
    const sourceWhere = buildMetricRollupWhereClause(tenantId, filters);
    const preferredResolution = bucketSeconds === 86400 ? Prisma.sql`MAX` : Prisma.sql`MIN`;
    const cursorCondition = cursor === undefined
      ? Prisma.empty
      : cursor.kind === 'legacy-date'
        ? Prisma.sql`WHERE bucket_start > ${cursor.bucketStart}`
        : Prisma.sql`
          WHERE (
            bucket_start, external_resource_id, COALESCE(cloud_resource_id, ''),
            provider_namespace, region_id, metric_name, dimensions_hash, granularity_seconds
          ) > (
            ${cursor.bucketStart}, ${cursor.externalResourceId}, ${cursor.cloudResourceId},
            ${cursor.providerNamespace}, ${cursor.regionId}, ${cursor.metricName},
            ${cursor.dimensionsHash}, ${bucketSeconds}
          )
        `;
    return this.prisma.$queryRaw<RawMetricSeriesRow[]>(Prisma.sql`
      WITH filtered AS (
        SELECT
          r.*,
          to_timestamp(floor(extract(epoch FROM r.bucket_start) / ${bucketSeconds}) * ${bucketSeconds}) AS target_bucket_start
        FROM resource_metric_rollups r
        WHERE ${sourceWhere} AND r.bucket_seconds <= ${bucketSeconds}
      ), preferred AS (
        SELECT tenant_id, cloud_connection_id, cloud_resource_id, external_resource_id,
          provider_namespace, region_id, dimensions_hash, metric_name, statistic,
          target_bucket_start, ${preferredResolution}(bucket_seconds) AS bucket_seconds
        FROM filtered
        GROUP BY tenant_id, cloud_connection_id, cloud_resource_id, external_resource_id,
          provider_namespace, region_id, dimensions_hash, metric_name, statistic, target_bucket_start
      ), source AS (
        SELECT filtered.*
        FROM filtered
        INNER JOIN preferred
          ON preferred.tenant_id = filtered.tenant_id
         AND preferred.cloud_connection_id = filtered.cloud_connection_id
         AND preferred.cloud_resource_id IS NOT DISTINCT FROM filtered.cloud_resource_id
         AND preferred.external_resource_id = filtered.external_resource_id
         AND preferred.provider_namespace = filtered.provider_namespace
         AND preferred.region_id = filtered.region_id
         AND preferred.dimensions_hash = filtered.dimensions_hash
         AND preferred.metric_name = filtered.metric_name
         AND preferred.statistic = filtered.statistic
         AND preferred.target_bucket_start = filtered.target_bucket_start
         AND preferred.bucket_seconds = filtered.bucket_seconds
      ), grouped AS (
        SELECT
          target_bucket_start AS bucket_start,
          max(provider)::text AS provider,
          external_resource_id,
          cloud_resource_id,
          provider_namespace,
          region_id,
          dimensions_hash,
          metric_name,
          max(metric_unit) AS metric_unit,
          statistic,
          ${bucketSeconds}::int AS granularity_seconds,
          CASE statistic::text
            WHEN 'MIN' THEN min(min_value)
            WHEN 'MAX' THEN max(max_value)
            WHEN 'P50' THEN COALESCE(avg(p50_value) FILTER (WHERE p50_value IS NOT NULL), sum(sum_value) / NULLIF(sum(sample_count), 0))
            WHEN 'P90' THEN COALESCE(avg(p90_value) FILTER (WHERE p90_value IS NOT NULL), sum(sum_value) / NULLIF(sum(sample_count), 0))
            WHEN 'P95' THEN COALESCE(avg(p95_value) FILTER (WHERE p95_value IS NOT NULL), sum(sum_value) / NULLIF(sum(sample_count), 0))
            WHEN 'P99' THEN COALESCE(avg(p99_value) FILTER (WHERE p99_value IS NOT NULL), sum(sum_value) / NULLIF(sum(sample_count), 0))
            WHEN 'SUM' THEN sum(sum_value)
            WHEN 'COUNT' THEN sum(sample_count)::numeric
            WHEN 'LATEST' THEN (array_agg(latest_value ORDER BY latest_sampled_at DESC))[1]
            ELSE sum(sum_value) / NULLIF(sum(sample_count), 0)
          END::float8 AS selected_value,
          CASE WHEN statistic::text IN ('P50', 'P90', 'P95', 'P99')
            THEN 'POSTGRES_ROLLUP_DERIVED_STATISTIC_AVG'
            ELSE 'POSTGRES_ROLLUP_DERIVED_PEAK_AWARE'
          END::text AS aggregation_semantics,
          array_agg(DISTINCT bucket_seconds ORDER BY bucket_seconds)::int[] AS source_granularities,
          sum(sum_value)::float8 AS sum_value,
          (sum(sum_value) / NULLIF(sum(sample_count), 0))::float8 AS avg_value,
          min(min_value)::float8 AS min_value,
          max(max_value)::float8 AS max_value,
          (array_agg(latest_value ORDER BY latest_sampled_at DESC))[1]::float8 AS latest_value,
          sum(sample_count)::int AS sample_count,
          min(min_sampled_at) AS min_sampled_at,
          (array_agg(max_sampled_at ORDER BY max_value DESC, max_sampled_at ASC))[1] AS max_sampled_at,
          max(latest_sampled_at) AS latest_sampled_at
        FROM source
        GROUP BY target_bucket_start, external_resource_id, cloud_resource_id, provider_namespace,
          region_id, dimensions_hash, metric_name, statistic
      )
      SELECT
        bucket_start, provider, external_resource_id, cloud_resource_id, provider_namespace, region_id,
        dimensions_hash, metric_name, metric_unit, statistic, granularity_seconds,
        selected_value, aggregation_semantics, source_granularities, avg_value, sum_value,
        min_value, max_value, latest_value, sample_count, min_sampled_at, max_sampled_at,
        latest_sampled_at
      FROM grouped
      ${cursorCondition}
      ORDER BY bucket_start ASC, external_resource_id ASC, COALESCE(cloud_resource_id, '') ASC,
        provider_namespace ASC, region_id ASC, metric_name ASC, dimensions_hash ASC, granularity_seconds ASC
      LIMIT ${limit}
    `);
  }
}

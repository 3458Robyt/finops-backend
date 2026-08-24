import type {
  TechnicalMetricSeriesFilters,
  TechnicalMetricSeriesRepositoryResult,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  buildBucketExpression,
  buildMetricSeriesCursor,
  buildMetricWhereClause,
  mapMetricSeriesRow,
  parseMetricSeriesCursor,
  type MetricSeriesCursor,
  type RawMetricSeriesRow,
} from './technicalMetricQueryHelpers.js';

/**
 * Reads paginated metric series without mixing SQL for resource lineage,
 * coverage, summaries, or cost context into the same repository class.
 */
export class PrismaResourceMetricSeriesReader {
  constructor(private readonly prisma: PrismaClient) {}

  public async listForTenant(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
  ): Promise<TechnicalMetricSeriesRepositoryResult> {
    const pageSize = filters.pageSize;
    const limit = pageSize + 1;
    const where = buildMetricWhereClause(tenantId, filters, false);
    const cursor = parseMetricSeriesCursor(filters.cursor);
    const rowsPromise = filters.bucket === 'raw'
      ? this.listRawRows(where, cursor, limit)
      : this.listAggregatedRows(where, cursor, filters.bucket, limit);

    const [totalSamples, rows] = await Promise.all([
      cursor === undefined ? this.countSamples(tenantId, filters) : Promise.resolve(0),
      rowsPromise,
    ]);

    const hasMore = rows.length > pageSize;
    const visibleRows = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore ? buildMetricSeriesCursor(visibleRows.at(-1)) : undefined;

    return {
      points: visibleRows.map((row) => mapMetricSeriesRow(row)),
      totalSamples,
      hasMore,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  private async listRawRows(
    where: Prisma.Sql,
    cursor: MetricSeriesCursor | undefined,
    limit: number,
  ): Promise<RawMetricSeriesRow[]> {
    const cursorCondition = cursor === undefined
      ? Prisma.empty
      : cursor.kind === 'legacy-date'
        ? Prisma.sql`AND sampled_at > ${cursor.bucketStart}`
        : Prisma.sql`
          AND (
            sampled_at, external_resource_id, COALESCE(cloud_resource_id, ''),
            provider_namespace, region_id, metric_name, dimensions_hash, granularity_seconds
          ) > (
            ${cursor.bucketStart}, ${cursor.externalResourceId}, ${cursor.cloudResourceId},
            ${cursor.providerNamespace}, ${cursor.regionId}, ${cursor.metricName},
            ${cursor.dimensionsHash}, ${cursor.granularitySeconds}
          )
        `;

    return this.prisma.$queryRaw<RawMetricSeriesRow[]>(Prisma.sql`
      SELECT
        sampled_at AS bucket_start,
        external_resource_id,
        cloud_resource_id,
        provider_namespace,
        region_id,
        dimensions_hash,
        metric_name,
        metric_unit,
        statistic::text AS statistic,
        granularity_seconds,
        value::float8 AS selected_value,
        'RAW_NATIVE'::text AS aggregation_semantics,
        ARRAY[granularity_seconds]::int[] AS source_granularities,
        value::float8 AS avg_value,
        value::float8 AS min_value,
        value::float8 AS max_value,
        value::float8 AS latest_value,
        1::int AS sample_count,
        sampled_at AS min_sampled_at,
        sampled_at AS max_sampled_at,
        sampled_at AS latest_sampled_at
      FROM resource_metric_samples
      WHERE ${where}
      ${cursorCondition}
      ORDER BY sampled_at ASC, external_resource_id ASC, COALESCE(cloud_resource_id, '') ASC,
        provider_namespace ASC, region_id ASC, metric_name ASC, dimensions_hash ASC, granularity_seconds ASC
      LIMIT ${limit}
    `);
  }

  private async listAggregatedRows(
    where: Prisma.Sql,
    cursor: MetricSeriesCursor | undefined,
    bucket: TechnicalMetricSeriesFilters['bucket'],
    limit: number,
  ): Promise<RawMetricSeriesRow[]> {
    const bucketExpression = buildBucketExpression(bucket);
    const resourceExpression = Prisma.sql`external_resource_id`;
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
            ${cursor.dimensionsHash}, ${cursor.granularitySeconds}
          )
        `;

    return this.prisma.$queryRaw<RawMetricSeriesRow[]>(Prisma.sql`
      WITH filtered AS (
        SELECT
          ${bucketExpression} AS bucket_start,
          ${resourceExpression} AS external_resource_id,
          cloud_resource_id,
          provider_namespace,
          region_id,
          dimensions_hash,
          metric_name,
          metric_unit,
          statistic,
          granularity_seconds,
          sampled_at,
          granularity_seconds,
          value::float8 AS value
        FROM resource_metric_samples
        WHERE ${where}
      ),
      grouped AS (
        SELECT
          bucket_start,
          external_resource_id,
          cloud_resource_id,
          provider_namespace,
          region_id,
          dimensions_hash,
          metric_name,
          metric_unit,
          statistic,
          granularity_seconds,
          CASE statistic::text
            WHEN 'MEAN' THEN avg(value)
            WHEN 'MIN' THEN min(value)
            WHEN 'MAX' THEN max(value)
            WHEN 'P50' THEN percentile_cont(0.50) WITHIN GROUP (ORDER BY value)
            WHEN 'P90' THEN percentile_cont(0.90) WITHIN GROUP (ORDER BY value)
            WHEN 'P95' THEN percentile_cont(0.95) WITHIN GROUP (ORDER BY value)
            WHEN 'P99' THEN percentile_cont(0.99) WITHIN GROUP (ORDER BY value)
            WHEN 'SUM' THEN sum(value)
            WHEN 'COUNT' THEN count(*)::float8
            WHEN 'LATEST' THEN (array_agg(value ORDER BY sampled_at DESC))[1]
            ELSE avg(value)
          END::float8 AS selected_value,
          CASE statistic::text
            WHEN 'P95' THEN 'P95_OF_NATIVE_P95'
            ELSE concat(upper(statistic::text), '_OF_NATIVE')
          END::text AS aggregation_semantics,
          array_agg(DISTINCT granularity_seconds ORDER BY granularity_seconds)::int[] AS source_granularities,
          avg(value)::float8 AS avg_value,
          min(value)::float8 AS min_value,
          max(value)::float8 AS max_value,
          (array_agg(value ORDER BY sampled_at DESC))[1]::float8 AS latest_value,
          count(*)::int AS sample_count,
          (array_agg(sampled_at ORDER BY value ASC, sampled_at ASC))[1] AS min_sampled_at,
          (array_agg(sampled_at ORDER BY value DESC, sampled_at ASC))[1] AS max_sampled_at,
          max(sampled_at) AS latest_sampled_at
        FROM filtered
        GROUP BY bucket_start, external_resource_id, cloud_resource_id, provider_namespace, region_id,
          dimensions_hash, metric_name, metric_unit, statistic, granularity_seconds
      )
      SELECT *
      FROM grouped
      ${cursorCondition}
      ORDER BY bucket_start ASC, external_resource_id ASC, COALESCE(cloud_resource_id, '') ASC,
        provider_namespace ASC, region_id ASC, metric_name ASC, dimensions_hash ASC, granularity_seconds ASC
      LIMIT ${limit}
    `);
  }

  private async countSamples(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
  ): Promise<number> {
    const countWhere = buildMetricWhereClause(tenantId, filters, false);
    const rows = await this.prisma.$queryRaw<{ readonly total: bigint }[]>(Prisma.sql`
      SELECT count(*)::bigint AS total
      FROM resource_metric_samples
      WHERE ${countWhere}
    `);

    return Number(rows[0]?.total ?? 0n);
  }
}

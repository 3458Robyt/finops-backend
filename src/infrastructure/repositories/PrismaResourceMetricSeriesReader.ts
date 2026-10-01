import type {
  TechnicalMetricSeriesFilters,
  TechnicalMetricSeriesRepositoryResult,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  buildBucketExpression,
  buildMetricSeriesCursor,
  buildMetricRollupWhereClause,
  buildMetricWhereClause,
  mapMetricSeriesRow,
  parseMetricSeriesCursor,
  type MetricSeriesCursor,
  type RawMetricSeriesRow,
} from './technicalMetricQueryHelpers.js';
import { PrismaResourceMetric30mRollupReader } from './PrismaResourceMetric30mRollupReader.js';
import { PrismaResourceMetricMixedRollupReader } from './PrismaResourceMetricMixedRollupReader.js';

/**
 * Reads paginated metric series without mixing SQL for resource lineage,
 * coverage, summaries, or cost context into the same repository class.
 */
export class PrismaResourceMetricSeriesReader {
  private readonly thirtyMinuteRollups: PrismaResourceMetric30mRollupReader;
  private readonly mixedRollups: PrismaResourceMetricMixedRollupReader;

  constructor(private readonly prisma: PrismaClient) {
    this.thirtyMinuteRollups = new PrismaResourceMetric30mRollupReader(prisma);
    this.mixedRollups = new PrismaResourceMetricMixedRollupReader(prisma);
  }

  public async listForTenant(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
  ): Promise<TechnicalMetricSeriesRepositoryResult> {
    const pageSize = filters.pageSize;
    const limit = pageSize + 1;
    const where = buildMetricWhereClause(tenantId, filters, false);
    const cursor = parseMetricSeriesCursor(filters.cursor);
    const bucketSeconds = filters.bucket === 'raw' ? undefined : bucketSecondsFor(filters.bucket);
    const exactPercentile = filters.bucket !== 'raw' && isPercentileStatistic(filters.statistic);
    let rows = await (filters.bucket === 'raw'
      ? this.listRawRows(where, cursor, limit)
      : exactPercentile
        ? this.listAggregatedRows(where, cursor, filters.bucket, limit)
        : this.listRollupRows(tenantId, filters, bucketSeconds!, cursor, limit));
    let totalSamples = 0;
    if (filters.bucket === 'raw' || exactPercentile) {
      totalSamples = cursor === undefined ? await this.countSamples(tenantId, filters) : 0;
    } else {
      // Raw samples are canonical. A backfill can finish before the rollup
      // worker refreshes its projection, so a non-empty rollup result is not
      // enough to trust the chart or its sample count.
      const [rollupTotal, rawTotal] = await Promise.all([
        this.countRollupSamples(tenantId, filters, bucketSeconds!),
        this.countSamples(tenantId, filters),
      ]);
      totalSamples = cursor === undefined ? rawTotal : 0;
      if (rollupTotal !== rawTotal) {
        rows = await this.listAggregatedRows(where, cursor, filters.bucket, limit);
      }
    }
    // Fixtures and a newly migrated database may contain raw samples before
    // the projection has been rebuilt. Keep the old SQL aggregation as a safe
    // compatibility path instead of returning an unexplained empty chart.
    if (filters.bucket !== 'raw' && !exactPercentile && rows.length === 0 && (totalSamples === 0 || cursor === undefined)) {
      const rawTotal = await this.countSamples(tenantId, filters);
      if (rawTotal > 0) {
        rows = await this.listAggregatedRows(where, cursor, filters.bucket, limit);
        totalSamples = rawTotal;
      }
    }

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

    const rows = await this.prisma.$queryRaw<RawMetricSeriesRow[]>(Prisma.sql`
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
    return rows;
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

  private async listRollupRows(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
    bucketSeconds: number,
    cursor: MetricSeriesCursor | undefined,
    limit: number,
  ): Promise<RawMetricSeriesRow[]> {
    // Keep native 30m and 1h samples as separate points. Never split an hourly
    // value into synthetic half-hour values; the source resolution is exposed.
    if (bucketSeconds === 1800) {
      return this.thirtyMinuteRollups.listFor(tenantId, filters, cursor, limit);
    }

    return this.mixedRollups.listFor(tenantId, filters, bucketSeconds, cursor, limit);
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

  private async countRollupSamples(
    tenantId: string,
    filters: TechnicalMetricSeriesFilters,
    bucketSeconds: number,
  ): Promise<number> {
    const where = buildMetricRollupWhereClause(tenantId, filters);
    if (bucketSeconds === 1800) return this.thirtyMinuteRollups.countFor(tenantId, filters);
    if (bucketSeconds === 3600) {
      const rows = await this.prisma.$queryRaw<{ readonly total: string | number | bigint }[]>(Prisma.sql`
        SELECT COALESCE(SUM(sample_count), 0)::bigint AS total
        FROM resource_metric_rollups
        WHERE ${where} AND bucket_seconds IN (1800, 3600)
      `);
      return Number(rows[0]?.total ?? 0);
    }

    const preferredResolution = Prisma.sql`MAX`;
    const rows = await this.prisma.$queryRaw<{ readonly total: string | number | bigint }[]>(Prisma.sql`
      WITH filtered AS (
        SELECT tenant_id, cloud_connection_id, cloud_resource_id, external_resource_id,
          provider_namespace, region_id, dimensions_hash, metric_name, statistic,
          bucket_seconds, sample_count,
          to_timestamp(floor(extract(epoch FROM bucket_start) / ${bucketSeconds}) * ${bucketSeconds}) AS target_bucket_start
        FROM resource_metric_rollups
        WHERE ${where} AND bucket_seconds <= ${bucketSeconds}
      ), preferred AS (
        SELECT tenant_id, cloud_connection_id, cloud_resource_id, external_resource_id,
          provider_namespace, region_id, dimensions_hash, metric_name, statistic,
          target_bucket_start, ${preferredResolution}(bucket_seconds) AS bucket_seconds
        FROM filtered
        GROUP BY tenant_id, cloud_connection_id, cloud_resource_id, external_resource_id,
          provider_namespace, region_id, dimensions_hash, metric_name, statistic, target_bucket_start
      )
      SELECT COALESCE(SUM(filtered.sample_count), 0)::bigint AS total
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
    `);
    return Number(rows[0]?.total ?? 0);
  }
}

function bucketSecondsFor(bucket: Exclude<TechnicalMetricSeriesFilters['bucket'], 'raw'>): number {
  if (bucket === '30m') return 1800;
  if (bucket === 'hour') return 3600;
  return 86400;
}

function isPercentileStatistic(statistic: TechnicalMetricSeriesFilters['statistic']): boolean {
  return statistic === 'P50' || statistic === 'P90' || statistic === 'P95' || statistic === 'P99';
}

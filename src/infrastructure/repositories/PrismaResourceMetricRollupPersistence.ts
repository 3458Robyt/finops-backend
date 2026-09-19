import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

const rollupRebuildChunkDays = 7;

/**
 * Maintains peak-preserving rollups for technical metric series.
 * Raw samples remain canonical; each source resolution plus a compact daily
 * projection is recomputed from all raw samples so retries and overlapping
 * backfills remain idempotent.
 */
export class PrismaResourceMetricRollupPersistence {
  public async refreshForJob(prisma: Pick<PrismaClient, '$executeRaw'>, ingestionJobId: string): Promise<number> {
    return prisma.$executeRaw(Prisma.sql`
      WITH job AS (
        SELECT "tenant_id", "cloud_connection_id", "target_start", "target_end"
        FROM ingestion_jobs
        WHERE id = ${ingestionJobId}
      ), affected AS MATERIALIZED (
        SELECT DISTINCT
          samples.tenant_id,
          samples.cloud_connection_id,
          samples.external_resource_id,
          samples.provider_namespace,
          samples.region_id,
          samples.dimensions_hash,
          samples.metric_name,
          samples.statistic,
          samples.granularity_seconds
        FROM resource_metric_samples samples
        WHERE samples.ingestion_job_id = ${ingestionJobId}
      ), source AS (
        SELECT samples.id, samples.tenant_id, samples.cloud_connection_id,
          samples.cloud_resource_id, samples.provider, samples.external_resource_id,
          samples.provider_namespace, samples.region_id, samples.compartment_id,
          samples.dimensions_hash, samples.metric_name, samples.metric_unit,
          samples.statistic, samples.value, samples.sampled_at,
          samples.granularity_seconds, bucket.bucket_seconds, bucket.bucket_start
        FROM resource_metric_samples samples
        CROSS JOIN job
        INNER JOIN affected
          ON affected.tenant_id = samples.tenant_id
         AND affected.cloud_connection_id = samples.cloud_connection_id
         AND affected.external_resource_id = samples.external_resource_id
         AND affected.provider_namespace = samples.provider_namespace
         AND affected.region_id = samples.region_id
          AND affected.dimensions_hash = samples.dimensions_hash
          AND affected.metric_name = samples.metric_name
          AND affected.statistic = samples.statistic
          AND affected.granularity_seconds = samples.granularity_seconds
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN samples.granularity_seconds <= 1800 THEN 1800
            WHEN samples.granularity_seconds <= 3600 THEN 3600
            ELSE 86400
          END::int AS source_bucket_seconds
        ) source_resolution
        CROSS JOIN LATERAL (
          SELECT source_resolution.source_bucket_seconds AS bucket_seconds
          UNION ALL
          SELECT 86400::int
          WHERE source_resolution.source_bucket_seconds <> 86400
        ) bucket_resolution
        CROSS JOIN LATERAL (
          SELECT bucket_resolution.bucket_seconds,
            to_timestamp(floor(extract(epoch FROM samples.sampled_at) / bucket_resolution.bucket_seconds) * bucket_resolution.bucket_seconds) AS bucket_start
        ) bucket
        WHERE samples.source_type = 'TECHNICAL_METRIC'::"IngestionSourceType"
          AND samples.sampled_at >= date_trunc('day', job."target_start")
          AND samples.sampled_at < date_trunc('day', job."target_end") + interval '1 day'
          AND bucket.bucket_start >= to_timestamp(
            floor(extract(epoch FROM job."target_start") / bucket.bucket_seconds)
            * bucket.bucket_seconds
          )
          AND bucket.bucket_start < to_timestamp(
            ceil(extract(epoch FROM job."target_end") / bucket.bucket_seconds)
            * bucket.bucket_seconds
          )
      ), grouped AS (
        SELECT tenant_id, cloud_connection_id, max(cloud_resource_id) AS cloud_resource_id,
          provider, external_resource_id, provider_namespace, region_id, max(compartment_id) AS compartment_id,
          dimensions_hash, metric_name, max(metric_unit) AS metric_unit, statistic,
           bucket_seconds, bucket_start, COUNT(*)::int AS sample_count,
           SUM(value)::numeric AS sum_value, AVG(value)::numeric AS avg_value,
           MIN(value)::numeric AS min_value,
           NULL::numeric AS p50_value,
           NULL::numeric AS p90_value,
           NULL::numeric AS p95_value,
           NULL::numeric AS p99_value,
           (array_agg(sampled_at ORDER BY value ASC, sampled_at ASC))[1] AS min_sampled_at,
          MAX(value)::numeric AS max_value,
          (array_agg(sampled_at ORDER BY value DESC, sampled_at ASC))[1] AS max_sampled_at,
          (array_agg(value ORDER BY sampled_at DESC, id DESC))[1]::numeric AS latest_value,
          MAX(sampled_at) AS latest_sampled_at,
          array_agg(DISTINCT granularity_seconds ORDER BY granularity_seconds)::int[] AS source_granularities
        FROM source
        GROUP BY tenant_id, cloud_connection_id, provider, external_resource_id,
          provider_namespace, region_id, dimensions_hash, metric_name, statistic,
          bucket_seconds, bucket_start
      )
      INSERT INTO resource_metric_rollups (
        id, tenant_id, cloud_connection_id, cloud_resource_id, provider,
        external_resource_id, provider_namespace, region_id, compartment_id,
        dimensions_hash, metric_name, metric_unit, statistic, bucket_seconds,
         bucket_start, sample_count, sum_value, avg_value, min_value,
         p50_value, p90_value, p95_value, p99_value, min_sampled_at, max_value, max_sampled_at,
         latest_value, latest_sampled_at,
        source_granularities, updated_at
      )
       SELECT md5(concat_ws('|', cloud_connection_id, provider_namespace, region_id,
        external_resource_id, metric_name, statistic::text, bucket_seconds::text,
        bucket_start::text, dimensions_hash)), tenant_id, cloud_connection_id,
        cloud_resource_id, provider, external_resource_id, provider_namespace,
        region_id, compartment_id, dimensions_hash, metric_name, metric_unit,
         statistic, bucket_seconds, bucket_start, sample_count, sum_value, avg_value,
         min_value, p50_value, p90_value, p95_value, p99_value, min_sampled_at, max_value,
         max_sampled_at, latest_value,
        latest_sampled_at, source_granularities, CURRENT_TIMESTAMP
      FROM grouped
      ON CONFLICT (cloud_connection_id, provider_namespace, region_id,
        external_resource_id, metric_name, statistic, bucket_seconds,
        bucket_start, dimensions_hash)
      DO UPDATE SET
        cloud_resource_id = EXCLUDED.cloud_resource_id,
        compartment_id = EXCLUDED.compartment_id,
        metric_unit = EXCLUDED.metric_unit,
        sample_count = EXCLUDED.sample_count,
        sum_value = EXCLUDED.sum_value,
         avg_value = EXCLUDED.avg_value,
         min_value = EXCLUDED.min_value,
         p50_value = EXCLUDED.p50_value,
         p90_value = EXCLUDED.p90_value,
         p95_value = EXCLUDED.p95_value,
         p99_value = EXCLUDED.p99_value,
        min_sampled_at = EXCLUDED.min_sampled_at,
        max_value = EXCLUDED.max_value,
        max_sampled_at = EXCLUDED.max_sampled_at,
        latest_value = EXCLUDED.latest_value,
        latest_sampled_at = EXCLUDED.latest_sampled_at,
        source_granularities = EXCLUDED.source_granularities,
        updated_at = CURRENT_TIMESTAMP
      WHERE resource_metric_rollups.cloud_resource_id IS DISTINCT FROM EXCLUDED.cloud_resource_id
        OR resource_metric_rollups.compartment_id IS DISTINCT FROM EXCLUDED.compartment_id
        OR resource_metric_rollups.metric_unit IS DISTINCT FROM EXCLUDED.metric_unit
        OR resource_metric_rollups.sample_count IS DISTINCT FROM EXCLUDED.sample_count
        OR resource_metric_rollups.sum_value IS DISTINCT FROM EXCLUDED.sum_value
        OR resource_metric_rollups.avg_value IS DISTINCT FROM EXCLUDED.avg_value
        OR resource_metric_rollups.min_value IS DISTINCT FROM EXCLUDED.min_value
        OR resource_metric_rollups.p50_value IS DISTINCT FROM EXCLUDED.p50_value
        OR resource_metric_rollups.p90_value IS DISTINCT FROM EXCLUDED.p90_value
        OR resource_metric_rollups.p95_value IS DISTINCT FROM EXCLUDED.p95_value
        OR resource_metric_rollups.p99_value IS DISTINCT FROM EXCLUDED.p99_value
        OR resource_metric_rollups.min_sampled_at IS DISTINCT FROM EXCLUDED.min_sampled_at
        OR resource_metric_rollups.max_value IS DISTINCT FROM EXCLUDED.max_value
        OR resource_metric_rollups.max_sampled_at IS DISTINCT FROM EXCLUDED.max_sampled_at
        OR resource_metric_rollups.latest_value IS DISTINCT FROM EXCLUDED.latest_value
        OR resource_metric_rollups.latest_sampled_at IS DISTINCT FROM EXCLUDED.latest_sampled_at
        OR resource_metric_rollups.source_granularities IS DISTINCT FROM EXCLUDED.source_granularities
    `);
  }

  public async refreshAll(prisma: PrismaClient, tenantId?: string): Promise<number> {
    const deleteScope = tenantId === undefined ? Prisma.sql`` : Prisma.sql`WHERE tenant_id = ${tenantId}`;
    await prisma.$executeRaw(Prisma.sql`DELETE FROM resource_metric_rollups ${deleteScope}`);

    const tenantScope = tenantId === undefined ? Prisma.sql`` : Prisma.sql`AND tenant_id = ${tenantId}`;
    const bounds = await prisma.$queryRaw<readonly [{ readonly first_sampled_at: Date | null; readonly last_sampled_at: Date | null }]>(Prisma.sql`
      SELECT min(sampled_at) AS first_sampled_at, max(sampled_at) AS last_sampled_at
      FROM resource_metric_samples
      WHERE source_type = 'TECHNICAL_METRIC'::"IngestionSourceType" ${tenantScope}
    `);
    const first = bounds[0]?.first_sampled_at;
    const last = bounds[0]?.last_sampled_at;
    if (first === null || first === undefined || last === null || last === undefined) return 0;

    let affected = 0;
    let chunkStart = startOfUtcDay(first);
    const finalExclusive = new Date(last.getTime() + 1);
    while (chunkStart < finalExclusive) {
      const chunkEnd = new Date(chunkStart.getTime() + rollupRebuildChunkDays * 24 * 60 * 60 * 1000);
      affected += await this.refreshAllBucket(prisma, tenantId, chunkStart, chunkEnd);
      chunkStart = chunkEnd;
    }
    return affected;
  }

  private async refreshAllBucket(
    prisma: PrismaClient,
    tenantId: string | undefined,
    startDate?: Date,
    endDate?: Date,
  ): Promise<number> {
    const scope = tenantId === undefined ? Prisma.sql`` : Prisma.sql`AND s.tenant_id = ${tenantId}`;
    const timeScope = startDate === undefined || endDate === undefined
      ? Prisma.sql``
      : Prisma.sql`AND s.sampled_at >= ${startDate} AND s.sampled_at < ${endDate}`;
    return prisma.$executeRaw(Prisma.sql`
      WITH source AS (
        SELECT s.id, s.tenant_id, s.cloud_connection_id, s.cloud_resource_id,
          s.provider, s.external_resource_id, s.provider_namespace, s.region_id,
          s.compartment_id, s.dimensions_hash, s.metric_name, s.metric_unit,
          s.statistic, s.value, s.sampled_at, s.granularity_seconds,
          bucket_resolution.bucket_seconds,
          to_timestamp(floor(extract(epoch FROM s.sampled_at) / bucket_resolution.bucket_seconds) * bucket_resolution.bucket_seconds) AS bucket_start
        FROM resource_metric_samples s
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN s.granularity_seconds <= 1800 THEN 1800
            WHEN s.granularity_seconds <= 3600 THEN 3600
            ELSE 86400
          END::int AS source_bucket_seconds
        ) source_resolution
        CROSS JOIN LATERAL (
          SELECT source_resolution.source_bucket_seconds AS bucket_seconds
          UNION ALL
          SELECT 86400::int
          WHERE source_resolution.source_bucket_seconds <> 86400
        ) bucket_resolution
        WHERE s.source_type = 'TECHNICAL_METRIC'::"IngestionSourceType"
          ${scope}
          ${timeScope}
      ), grouped AS (
        SELECT tenant_id, cloud_connection_id, max(cloud_resource_id) AS cloud_resource_id,
          provider, external_resource_id, provider_namespace, region_id, max(compartment_id) AS compartment_id,
          dimensions_hash, metric_name, max(metric_unit) AS metric_unit, statistic,
           bucket_seconds, bucket_start, COUNT(*)::int AS sample_count,
           SUM(value)::numeric AS sum_value, AVG(value)::numeric AS avg_value,
           MIN(value)::numeric AS min_value,
           NULL::numeric AS p50_value,
           NULL::numeric AS p90_value,
           NULL::numeric AS p95_value,
           NULL::numeric AS p99_value,
           (array_agg(sampled_at ORDER BY value ASC, sampled_at ASC))[1] AS min_sampled_at,
          MAX(value)::numeric AS max_value,
          (array_agg(sampled_at ORDER BY value DESC, sampled_at ASC))[1] AS max_sampled_at,
          (array_agg(value ORDER BY sampled_at DESC, id DESC))[1]::numeric AS latest_value,
          MAX(sampled_at) AS latest_sampled_at,
          array_agg(DISTINCT granularity_seconds ORDER BY granularity_seconds)::int[] AS source_granularities
        FROM source
        GROUP BY tenant_id, cloud_connection_id, provider, external_resource_id,
          provider_namespace, region_id, dimensions_hash, metric_name, statistic,
          bucket_seconds, bucket_start
      )
      INSERT INTO resource_metric_rollups (
        id, tenant_id, cloud_connection_id, cloud_resource_id, provider,
        external_resource_id, provider_namespace, region_id, compartment_id,
        dimensions_hash, metric_name, metric_unit, statistic, bucket_seconds,
         bucket_start, sample_count, sum_value, avg_value, min_value,
         p50_value, p90_value, p95_value, p99_value, min_sampled_at, max_value, max_sampled_at,
         latest_value, latest_sampled_at,
        source_granularities, updated_at
      )
      SELECT md5(concat_ws('|', cloud_connection_id, provider_namespace, region_id,
        external_resource_id, metric_name, statistic::text, bucket_seconds::text,
        bucket_start::text, dimensions_hash)), tenant_id, cloud_connection_id,
        cloud_resource_id, provider, external_resource_id, provider_namespace,
        region_id, compartment_id, dimensions_hash, metric_name, metric_unit,
         statistic, bucket_seconds, bucket_start, sample_count, sum_value, avg_value,
         min_value, p50_value, p90_value, p95_value, p99_value, min_sampled_at, max_value,
         max_sampled_at, latest_value,
        latest_sampled_at, source_granularities, CURRENT_TIMESTAMP
      FROM grouped
    `);
  }
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

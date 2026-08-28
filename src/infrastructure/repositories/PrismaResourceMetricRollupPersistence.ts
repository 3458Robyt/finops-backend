import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * Maintains peak-preserving rollups for technical metric series.
 * Raw samples remain canonical; affected buckets are recomputed from all raw
 * samples so retries and overlapping backfills remain idempotent.
 */
export class PrismaResourceMetricRollupPersistence {
  public async refreshForJob(prisma: Pick<PrismaClient, '$executeRaw'>, ingestionJobId: string): Promise<number> {
    return prisma.$executeRaw(Prisma.sql`
      WITH job AS (
        SELECT "tenant_id", "cloud_connection_id", "target_start", "target_end"
        FROM ingestion_jobs
        WHERE id = ${ingestionJobId}
      ), affected AS (
        SELECT DISTINCT
          samples.tenant_id,
          samples.cloud_connection_id,
          samples.cloud_resource_id,
          samples.external_resource_id,
          samples.provider_namespace,
          samples.region_id,
          samples.dimensions_hash,
          samples.metric_name,
          samples.statistic
        FROM resource_metric_samples samples
        WHERE samples.ingestion_job_id = ${ingestionJobId}
      ), filtered_samples AS MATERIALIZED (
        SELECT samples.id, samples.tenant_id, samples.cloud_connection_id,
          samples.cloud_resource_id, samples.provider, samples.external_resource_id,
          samples.provider_namespace, samples.region_id, samples.compartment_id,
          samples.dimensions_hash, samples.metric_name, samples.metric_unit,
          samples.statistic, samples.value, samples.sampled_at,
          samples.granularity_seconds
        FROM resource_metric_samples samples
        CROSS JOIN job
        WHERE samples.sampled_at >= date_trunc('day', job."target_start")
          AND samples.sampled_at < date_trunc('day', job."target_end") + interval '1 day'
          AND samples.tenant_id = job."tenant_id"
          AND samples.cloud_connection_id = job."cloud_connection_id"
          AND samples.source_type = 'TECHNICAL_METRIC'::"IngestionSourceType"
      ), source AS (
        SELECT samples.*, bucket.bucket_seconds, bucket.bucket_start
        FROM filtered_samples samples
        CROSS JOIN job
        INNER JOIN affected
          ON affected.tenant_id = samples.tenant_id
         AND affected.cloud_connection_id = samples.cloud_connection_id
         AND affected.cloud_resource_id IS NOT DISTINCT FROM samples.cloud_resource_id
         AND affected.external_resource_id = samples.external_resource_id
         AND affected.provider_namespace = samples.provider_namespace
         AND affected.region_id = samples.region_id
          AND affected.dimensions_hash = samples.dimensions_hash
          AND affected.metric_name = samples.metric_name
          AND affected.statistic = samples.statistic
        CROSS JOIN (VALUES (1800), (3600), (86400)) AS buckets(bucket_seconds)
        CROSS JOIN LATERAL (
            SELECT buckets.bucket_seconds,
              to_timestamp(floor(extract(epoch FROM samples.sampled_at) / buckets.bucket_seconds) * buckets.bucket_seconds) AS bucket_start
          ) bucket
        WHERE bucket.bucket_start >= to_timestamp(
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
    const scope = tenantId === undefined ? Prisma.sql`` : Prisma.sql`WHERE tenant_id = ${tenantId}`;
    await prisma.$executeRaw(Prisma.sql`DELETE FROM resource_metric_rollups ${scope}`);
    let inserted = 0;
    for (const bucketSeconds of [1800, 3600, 86400]) {
      inserted += await this.refreshAllBucket(prisma, tenantId, bucketSeconds);
    }
    return inserted;
  }

  private async refreshAllBucket(
    prisma: PrismaClient,
    tenantId: string | undefined,
    bucketSeconds: number,
  ): Promise<number> {
    const scope = tenantId === undefined ? Prisma.sql`` : Prisma.sql`WHERE tenant_id = ${tenantId}`;
    return prisma.$executeRaw(Prisma.sql`
      WITH source AS (
        SELECT s.id, s.tenant_id, s.cloud_connection_id, s.cloud_resource_id,
          s.provider, s.external_resource_id, s.provider_namespace, s.region_id,
          s.compartment_id, s.dimensions_hash, s.metric_name, s.metric_unit,
          s.statistic, s.value, s.sampled_at, s.granularity_seconds,
          ${bucketSeconds}::int AS bucket_seconds,
          to_timestamp(floor(extract(epoch FROM s.sampled_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket_start
        FROM resource_metric_samples s
        ${scope}
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

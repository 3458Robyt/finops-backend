import { Prisma } from '../src/generated/prisma/client.js';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';

/** Rebuilds the persisted technical-stream coverage projection idempotently. */
async function main(): Promise<void> {
  const prisma = getPrismaClient();
  const now = new Date();
  const affected = await prisma.$executeRaw(Prisma.sql`
    INSERT INTO resource_metric_stream_summaries (
      id, tenant_id, cloud_connection_id, cloud_resource_id, provider, external_resource_id,
      provider_namespace, region_id, compartment_id, dimensions_hash, metric_name, metric_unit,
      statistic, granularity_seconds, sample_count, non_zero_sample_count, first_sampled_at,
      last_sampled_at, latest_value, state, last_ingested_at, updated_at
    )
    SELECT
      md5(concat_ws('|', rms.cloud_connection_id, rms.provider_namespace, rms.region_id,
        rms.external_resource_id, rms.metric_name, rms.statistic::text,
        rms.granularity_seconds::text, rms.dimensions_hash)),
      max(rms.tenant_id), rms.cloud_connection_id,
      (array_agg(rms.cloud_resource_id ORDER BY rms.sampled_at DESC NULLS LAST))[1],
      (array_agg(rms.provider ORDER BY rms.sampled_at DESC))[1], rms.external_resource_id,
      rms.provider_namespace, rms.region_id, max(rms.compartment_id), rms.dimensions_hash,
      rms.metric_name, max(rms.metric_unit), rms.statistic, rms.granularity_seconds,
      count(*)::int, count(*) FILTER (WHERE rms.value <> 0)::int,
      min(rms.sampled_at), max(rms.sampled_at),
      (array_agg(rms.value ORDER BY rms.sampled_at DESC))[1],
      CASE
        WHEN count(*) FILTER (WHERE rms.value <> 0) = 0 THEN 'ZERO_ONLY'
        WHEN max(rms.sampled_at) < (${now}::timestamptz - interval '48 hours') THEN 'STALE'
        ELSE 'ACTIVE'
      END,
      ${now}, ${now}
    FROM resource_metric_samples rms
    GROUP BY rms.cloud_connection_id, rms.external_resource_id, rms.provider_namespace,
      rms.region_id, rms.dimensions_hash, rms.metric_name, rms.statistic, rms.granularity_seconds
    ON CONFLICT (
      cloud_connection_id, provider_namespace, region_id, external_resource_id,
      metric_name, statistic, granularity_seconds, dimensions_hash
    ) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      cloud_resource_id = EXCLUDED.cloud_resource_id,
      provider = EXCLUDED.provider,
      compartment_id = EXCLUDED.compartment_id,
      metric_unit = EXCLUDED.metric_unit,
      sample_count = EXCLUDED.sample_count,
      non_zero_sample_count = EXCLUDED.non_zero_sample_count,
      first_sampled_at = EXCLUDED.first_sampled_at,
      last_sampled_at = EXCLUDED.last_sampled_at,
      latest_value = EXCLUDED.latest_value,
      state = EXCLUDED.state,
      last_ingested_at = EXCLUDED.last_ingested_at,
      updated_at = EXCLUDED.updated_at
  `);
  console.log(JSON.stringify({ event: 'metric_stream_summaries_rebuilt', affected }));
  await prisma.$disconnect();
}

void main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : 'No se pudo reconstruir el resumen de streams.');
  process.exitCode = 1;
});

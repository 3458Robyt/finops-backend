import type { NormalizedResourceMetricSample } from '../../domain/interfaces/ICloudIngestionProvider.js';
import { Prisma as PrismaNamespace } from '../../generated/prisma/client.js';
import type { PrismaIngestionPersistenceClient } from './ingestionPersistenceTypes.js';

/** Rebuilds or incrementally refreshes the native stream summary projection. */
export class PrismaMetricStreamSummaryPersistence {
  /** Refreshes one row per native provider stream without loading history into Node. */
  public async refreshMetricStreamSummaries(
    tx: PrismaIngestionPersistenceClient,
    cloudConnectionId: string,
    samples: readonly NormalizedResourceMetricSample[],
    now = new Date(),
  ): Promise<void> {
    const affected = uniqueStreamIdentities(samples);
    if (affected.length === 0) return;

    await tx.$executeRaw(PrismaNamespace.sql`
      WITH affected AS (
        SELECT DISTINCT
          payload.provider_namespace,
          payload.region_id,
          payload.external_resource_id,
          payload.metric_name,
          payload.statistic::"MetricStatistic" AS statistic,
          payload.granularity_seconds,
          payload.dimensions_hash
        FROM jsonb_to_recordset(${JSON.stringify(affected)}::jsonb) AS payload(
          provider_namespace text,
          region_id text,
          external_resource_id text,
          metric_name text,
          statistic text,
          granularity_seconds integer,
          dimensions_hash varchar(64)
        )
      ), aggregated AS (
        SELECT
          max(rms.tenant_id) AS tenant_id,
          rms.cloud_connection_id,
          (array_agg(rms.cloud_resource_id ORDER BY rms.sampled_at DESC NULLS LAST))[1] AS cloud_resource_id,
          (array_agg(rms.provider ORDER BY rms.sampled_at DESC))[1] AS provider,
          rms.external_resource_id,
          rms.provider_namespace,
          rms.region_id,
          max(rms.compartment_id) AS compartment_id,
          rms.dimensions_hash,
          rms.metric_name,
          max(rms.metric_unit) AS metric_unit,
          rms.statistic,
          rms.granularity_seconds,
          count(*)::int AS sample_count,
          count(*) FILTER (WHERE rms.value <> 0)::int AS non_zero_sample_count,
          min(rms.sampled_at) AS first_sampled_at,
          max(rms.sampled_at) AS last_sampled_at,
          (array_agg(rms.value ORDER BY rms.sampled_at DESC))[1] AS latest_value
        FROM resource_metric_samples rms
        INNER JOIN affected
          ON affected.provider_namespace = rms.provider_namespace
         AND affected.region_id = rms.region_id
         AND affected.external_resource_id = rms.external_resource_id
         AND affected.metric_name = rms.metric_name
         AND affected.statistic = rms.statistic
         AND affected.granularity_seconds = rms.granularity_seconds
         AND affected.dimensions_hash = rms.dimensions_hash
        WHERE rms.cloud_connection_id = ${cloudConnectionId}
        GROUP BY rms.cloud_connection_id, rms.external_resource_id, rms.provider_namespace,
          rms.region_id, rms.dimensions_hash, rms.metric_name, rms.statistic, rms.granularity_seconds
      )
      INSERT INTO resource_metric_stream_summaries (
        id, tenant_id, cloud_connection_id, cloud_resource_id, provider, external_resource_id,
        provider_namespace, region_id, compartment_id, dimensions_hash, metric_name, metric_unit,
        statistic, granularity_seconds, sample_count, non_zero_sample_count, first_sampled_at,
        last_sampled_at, latest_value, state, last_ingested_at, updated_at
      )
      SELECT
        md5(concat_ws('|', cloud_connection_id, provider_namespace, region_id, external_resource_id,
          metric_name, statistic::text, granularity_seconds::text, dimensions_hash)),
        tenant_id, cloud_connection_id, cloud_resource_id, provider, external_resource_id,
        provider_namespace, region_id, compartment_id, dimensions_hash, metric_name, metric_unit,
        statistic, granularity_seconds, sample_count, non_zero_sample_count, first_sampled_at,
        last_sampled_at, latest_value,
        CASE
          WHEN non_zero_sample_count = 0 THEN 'ZERO_ONLY'
           WHEN last_sampled_at < (${now}::timestamptz - interval '48 hours') THEN 'STALE'
          ELSE 'ACTIVE'
        END,
        ${now}, ${now}
      FROM aggregated
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
  }

  /** Updates summaries from rows written by one job without rescanning all history. */
  public async refreshMetricStreamSummariesForJob(
    tx: PrismaIngestionPersistenceClient,
    ingestionJobId: string,
    now = new Date(),
  ): Promise<void> {
    await tx.$executeRaw(PrismaNamespace.sql`
      WITH aggregated AS (
        SELECT
          max(rms.tenant_id) AS tenant_id,
          rms.cloud_connection_id,
          (array_agg(rms.cloud_resource_id ORDER BY rms.sampled_at DESC NULLS LAST))[1] AS cloud_resource_id,
          (array_agg(rms.provider ORDER BY rms.sampled_at DESC))[1] AS provider,
          rms.external_resource_id,
          rms.provider_namespace,
          rms.region_id,
          max(rms.compartment_id) AS compartment_id,
          rms.dimensions_hash,
          rms.metric_name,
          max(rms.metric_unit) AS metric_unit,
          rms.statistic,
          rms.granularity_seconds,
          count(*)::int AS sample_count,
          count(*) FILTER (WHERE rms.value <> 0)::int AS non_zero_sample_count,
          min(rms.sampled_at) AS first_sampled_at,
          max(rms.sampled_at) AS last_sampled_at,
          (array_agg(rms.value ORDER BY rms.sampled_at DESC))[1] AS latest_value
        FROM resource_metric_samples rms
        WHERE rms.ingestion_job_id = ${ingestionJobId}
        GROUP BY rms.cloud_connection_id, rms.external_resource_id, rms.provider_namespace,
          rms.region_id, rms.dimensions_hash, rms.metric_name, rms.statistic, rms.granularity_seconds
      )
      INSERT INTO resource_metric_stream_summaries (
        id, tenant_id, cloud_connection_id, cloud_resource_id, provider, external_resource_id,
        provider_namespace, region_id, compartment_id, dimensions_hash, metric_name, metric_unit,
        statistic, granularity_seconds, sample_count, non_zero_sample_count, first_sampled_at,
        last_sampled_at, latest_value, state, last_ingested_at, updated_at
      )
      SELECT
        md5(concat_ws('|', cloud_connection_id, provider_namespace, region_id, external_resource_id,
          metric_name, statistic::text, granularity_seconds::text, dimensions_hash)),
        tenant_id, cloud_connection_id, cloud_resource_id, provider, external_resource_id,
        provider_namespace, region_id, compartment_id, dimensions_hash, metric_name, metric_unit,
        statistic, granularity_seconds, sample_count, non_zero_sample_count, first_sampled_at,
        last_sampled_at, latest_value,
        CASE WHEN non_zero_sample_count = 0 THEN 'ZERO_ONLY' ELSE 'ACTIVE' END,
        ${now}, ${now}
      FROM aggregated
      ON CONFLICT (
        cloud_connection_id, provider_namespace, region_id, external_resource_id,
        metric_name, statistic, granularity_seconds, dimensions_hash
      ) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        cloud_resource_id = COALESCE(EXCLUDED.cloud_resource_id, resource_metric_stream_summaries.cloud_resource_id),
        provider = EXCLUDED.provider,
        compartment_id = EXCLUDED.compartment_id,
        metric_unit = COALESCE(EXCLUDED.metric_unit, resource_metric_stream_summaries.metric_unit),
        sample_count = resource_metric_stream_summaries.sample_count + EXCLUDED.sample_count,
        non_zero_sample_count = resource_metric_stream_summaries.non_zero_sample_count + EXCLUDED.non_zero_sample_count,
        first_sampled_at = LEAST(
          COALESCE(resource_metric_stream_summaries.first_sampled_at, EXCLUDED.first_sampled_at),
          EXCLUDED.first_sampled_at
        ),
        last_sampled_at = GREATEST(
          COALESCE(resource_metric_stream_summaries.last_sampled_at, EXCLUDED.last_sampled_at),
          EXCLUDED.last_sampled_at
        ),
        latest_value = CASE
          WHEN resource_metric_stream_summaries.last_sampled_at IS NULL
            OR EXCLUDED.last_sampled_at >= resource_metric_stream_summaries.last_sampled_at
          THEN EXCLUDED.latest_value
          ELSE resource_metric_stream_summaries.latest_value
        END,
        state = CASE
          WHEN resource_metric_stream_summaries.non_zero_sample_count + EXCLUDED.non_zero_sample_count = 0
          THEN 'ZERO_ONLY'
          ELSE 'ACTIVE'
        END,
        last_ingested_at = ${now},
        updated_at = ${now}
    `);
  }
}

function uniqueStreamIdentities(
  samples: readonly NormalizedResourceMetricSample[],
): readonly Record<string, string | number>[] {
  const identities = new Map<string, Record<string, string | number>>();
  for (const sample of samples) {
    const identity = {
      provider_namespace: sample.providerNamespace ?? '',
      region_id: sample.regionId ?? '',
      external_resource_id: sample.externalResourceId,
      metric_name: sample.metricName,
      statistic: sample.statistic ?? 'MEAN',
      granularity_seconds: sample.granularitySeconds,
      dimensions_hash: sample.dimensionsHash ?? '',
    };
    identities.set(JSON.stringify(identity), identity);
  }
  return [...identities.values()];
}

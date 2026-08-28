import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { PrismaIngestionPersistenceClient } from './ingestionPersistenceTypes.js';

export interface MetricCoverageRefreshTarget {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly configurationHash?: string;
  readonly defaultGranularitySeconds?: number;
  readonly ingestionJobId?: string;
}

/**
 * Rebuilds daily coverage rows for streams touched by one raw job.
 *
 * Raw samples are canonical. The query aggregates them once by stream/day and
 * then joins that compact result to the expected metric definitions. It avoids
 * joining every expected stream back to the raw table, which is important for
 * connections with hundreds of metric definitions and long backfills.
 */
export class PrismaMetricCoveragePersistence {
  public async refreshForJob(
    tx: PrismaIngestionPersistenceClient | Pick<PrismaClient, '$executeRaw'>,
    ingestionJobId: string,
    now = new Date(),
  ): Promise<number> {
    return this.refresh(tx, { ingestionJobId }, now);
  }

  /** Rebuilds coverage for a connection range without creating a fake job. */
  public async refreshForConnectionRange(
    tx: PrismaIngestionPersistenceClient | Pick<PrismaClient, '$executeRaw'>,
    target: MetricCoverageRefreshTarget,
    now = new Date(),
  ): Promise<number> {
    return this.refresh(tx, target, now);
  }

  private async refresh(
    tx: PrismaIngestionPersistenceClient | Pick<PrismaClient, '$executeRaw'>,
    target: MetricCoverageRefreshTarget | { readonly ingestionJobId: string },
    now: Date,
  ): Promise<number> {
    const hasJob = 'ingestionJobId' in target;
    const jobSource = !hasJob
      ? Prisma.sql`
          SELECT
            NULL::text AS "id",
            ${target.tenantId}::text AS "tenant_id",
            ${target.cloudConnectionId}::text AS "cloud_connection_id",
            ${target.targetStart}::timestamptz AS "target_start",
            ${target.targetEnd}::timestamptz AS "target_end",
            ${target.configurationHash ?? ''}::varchar(64) AS "configuration_hash",
            ${target.defaultGranularitySeconds ?? 1800}::int AS "default_granularity"
        `
      : Prisma.sql`
          SELECT
            j."id",
            j."tenant_id",
            j."cloud_connection_id",
            j."target_start",
            j."target_end",
            COALESCE(NULLIF(j."configuration_hash", ''), '') AS "configuration_hash",
            COALESCE(NULLIF(j."request_context"->>'resolutionSeconds', '')::int, 1800) AS "default_granularity"
          FROM "ingestion_jobs" j
          WHERE j."id" = CAST(${target.ingestionJobId} AS text)
        `;
    const jobIdSql = !hasJob
      ? Prisma.sql`NULL::text`
      : Prisma.sql`${target.ingestionJobId}::text`;

    return tx.$executeRaw(Prisma.sql`
      WITH job AS (${jobSource}), days AS (
        SELECT
          job.*,
          generate_series(
            date_trunc('day', job."target_start"),
            date_trunc('day', GREATEST(job."target_start", job."target_end" - interval '1 microsecond')),
            interval '1 day'
          ) AS window_start
        FROM job
      ), data_range AS MATERIALIZED (
        SELECT
          MIN(days.window_start) AS range_start,
          MAX(days.window_start) + interval '1 day' AS range_end
        FROM days
      ), expected_streams AS MATERIALIZED (
        SELECT
          max(definition."id") AS cloud_metric_definition_id,
          days."tenant_id",
          days."cloud_connection_id",
          COALESCE(definition."namespace", '') AS provider_namespace,
          COALESCE(definition."region_id", '') AS region_id,
          COALESCE(definition."external_resource_id", '') AS external_resource_id,
          definition."metric_name",
          upper(statistic.value) AS statistic,
          days.default_granularity AS granularity_seconds,
          COALESCE(definition."dimensions_hash", '') AS dimensions_hash,
          days.window_start,
          days.window_start + interval '1 day' AS window_end,
          days.configuration_hash
        FROM days
        INNER JOIN "cloud_metric_definitions" definition
          ON definition."tenant_id" = days."tenant_id"
         AND definition."cloud_connection_id" = days."cloud_connection_id"
         AND definition."enabled" = true
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(definition."statistics") = 'array' THEN definition."statistics"
            ELSE '[]'::jsonb
          END
        ) AS statistic(value)
        WHERE upper(statistic.value) IN ('MEAN', 'MIN', 'MAX', 'P50', 'P90', 'P95', 'P99', 'SUM', 'COUNT', 'RATE', 'LATEST')
        GROUP BY days."tenant_id", days."cloud_connection_id", provider_namespace,
          region_id, external_resource_id, definition."metric_name", upper(statistic.value),
          days.default_granularity, dimensions_hash, days.window_start,
          days.window_start + interval '1 day', days.configuration_hash
      ), observed_streams AS MATERIALIZED (
        SELECT
          max(samples."tenant_id") AS "tenant_id",
          samples."cloud_connection_id",
          samples."provider_namespace",
          samples."region_id",
          samples."external_resource_id",
          samples."metric_name",
          samples."statistic"::text AS statistic,
          samples."granularity_seconds",
          samples."dimensions_hash",
          days.window_start,
          days.window_start + interval '1 day' AS window_end,
          days.configuration_hash,
          count(*)::int AS observed_samples
        FROM "resource_metric_samples" samples
        INNER JOIN days
          ON samples."tenant_id" = days."tenant_id"
         AND samples."cloud_connection_id" = days."cloud_connection_id"
         AND samples."sampled_at" >= days.window_start
         AND samples."sampled_at" < days.window_start + interval '1 day'
        CROSS JOIN data_range
        WHERE samples."source_type" = 'TECHNICAL_METRIC'::"IngestionSourceType"
          AND samples."sampled_at" >= data_range.range_start
          AND samples."sampled_at" < data_range.range_end
        GROUP BY samples."cloud_connection_id", samples."provider_namespace",
          samples."region_id", samples."external_resource_id", samples."metric_name",
          samples."statistic", samples."granularity_seconds", samples."dimensions_hash",
          days.window_start, days.configuration_hash
      ), streams AS (
        SELECT
          expected.cloud_metric_definition_id,
          expected."tenant_id",
          expected."cloud_connection_id",
          expected.provider_namespace,
          expected.region_id,
          expected.external_resource_id,
          expected.metric_name,
          expected.statistic,
          expected.granularity_seconds,
          expected.dimensions_hash,
          expected.window_start,
          expected.window_end,
          expected.configuration_hash,
          COALESCE(observed.observed_samples, 0) AS observed_samples
        FROM expected_streams expected
        LEFT JOIN observed_streams observed
          ON observed."cloud_connection_id" = expected."cloud_connection_id"
         AND observed.provider_namespace = expected.provider_namespace
         AND observed.region_id = expected.region_id
         AND observed.external_resource_id = expected.external_resource_id
         AND observed.metric_name = expected.metric_name
         AND observed.statistic = expected.statistic
         AND observed."granularity_seconds" = expected.granularity_seconds
         AND observed."dimensions_hash" = expected.dimensions_hash
         AND observed.window_start = expected.window_start
         AND observed.window_end = expected.window_end
         AND observed.configuration_hash = expected.configuration_hash
        UNION ALL
        SELECT
          NULL::text AS cloud_metric_definition_id,
          observed."tenant_id",
          observed."cloud_connection_id",
          observed.provider_namespace,
          observed.region_id,
          observed.external_resource_id,
          observed.metric_name,
          observed.statistic,
          observed."granularity_seconds",
          observed."dimensions_hash",
          observed.window_start,
          observed.window_end,
          observed.configuration_hash,
          observed.observed_samples
        FROM observed_streams observed
        WHERE NOT EXISTS (
          SELECT 1
          FROM expected_streams expected
          WHERE expected."cloud_connection_id" = observed."cloud_connection_id"
            AND expected.provider_namespace = observed.provider_namespace
            AND expected.region_id = observed.region_id
            AND expected.external_resource_id = observed.external_resource_id
            AND expected.metric_name = observed.metric_name
            AND expected.statistic = observed.statistic
            AND expected.granularity_seconds = observed."granularity_seconds"
            AND expected.dimensions_hash = observed."dimensions_hash"
            AND expected.window_start = observed.window_start
            AND expected.window_end = observed.window_end
            AND expected.configuration_hash = observed.configuration_hash
        )
      ), calculated AS (
        SELECT
          streams.*,
          GREATEST(
            0,
            CEIL(EXTRACT(EPOCH FROM (
              LEAST(streams.window_end, CAST(${now.toISOString()} AS timestamptz)) - streams.window_start
            )) / NULLIF(streams.granularity_seconds, 0))
          )::int AS expected_samples
        FROM streams
      )
      INSERT INTO "resource_metric_coverage_windows" (
        "id", "tenant_id", "cloud_connection_id", "cloud_metric_definition_id",
        "ingestion_job_id", "stream_key", "provider_namespace", "region_id",
        "external_resource_id", "metric_name", "statistic", "granularity_seconds",
        "window_start", "window_end", "status", "expected_samples", "observed_samples",
        "missing_samples", "configuration_hash", "evidence", "checked_at", "updated_at"
      )
      SELECT
        md5(concat_ws('|', calculated."cloud_connection_id", calculated.provider_namespace,
          calculated.region_id, calculated.external_resource_id, calculated.metric_name,
          calculated.statistic, calculated.granularity_seconds::text, calculated.dimensions_hash,
          calculated.window_start::text, calculated.window_end::text, calculated.configuration_hash)),
        calculated."tenant_id",
        calculated."cloud_connection_id",
        calculated.cloud_metric_definition_id,
        ${jobIdSql},
        md5(concat_ws('|', calculated.provider_namespace, calculated.region_id,
          calculated.external_resource_id, calculated.metric_name, calculated.statistic,
          calculated.granularity_seconds::text, calculated.dimensions_hash)),
        calculated.provider_namespace,
        calculated.region_id,
        calculated.external_resource_id,
        calculated.metric_name,
        calculated.statistic::"MetricStatistic",
        calculated.granularity_seconds,
        calculated.window_start,
        calculated.window_end,
        CASE
          WHEN calculated.observed_samples = 0 THEN 'NO_DATA'::"MetricCoverageStatus"
          WHEN calculated.expected_samples = 0
            OR calculated.observed_samples >= CEIL(calculated.expected_samples * 0.95)
            THEN 'COVERED'::"MetricCoverageStatus"
          ELSE 'PARTIAL'::"MetricCoverageStatus"
        END,
        calculated.expected_samples,
        calculated.observed_samples,
        GREATEST(calculated.expected_samples - calculated.observed_samples, 0),
        calculated.configuration_hash,
        jsonb_build_object(
          'source', 'resource_metric_samples',
          'jobId', ${jobIdSql},
          'computedAt', CAST(${now.toISOString()} AS text),
          'dailyWindow', true,
          'aggregation', 'stream_day_single_scan'
        ),
        CAST(${now.toISOString()} AS timestamptz),
        CAST(${now.toISOString()} AS timestamptz)
      FROM calculated
      ON CONFLICT (
        "cloud_connection_id", "stream_key", "granularity_seconds",
        "window_start", "window_end", "configuration_hash"
      ) DO UPDATE SET
        "tenant_id" = EXCLUDED."tenant_id",
        "cloud_metric_definition_id" = COALESCE(
          EXCLUDED."cloud_metric_definition_id",
          "resource_metric_coverage_windows"."cloud_metric_definition_id"
        ),
        "ingestion_job_id" = EXCLUDED."ingestion_job_id",
        "status" = EXCLUDED."status",
        "expected_samples" = EXCLUDED."expected_samples",
        "observed_samples" = EXCLUDED."observed_samples",
        "missing_samples" = EXCLUDED."missing_samples",
        "evidence" = EXCLUDED."evidence",
        "checked_at" = EXCLUDED."checked_at",
        "updated_at" = EXCLUDED."updated_at"
    `);
  }
}

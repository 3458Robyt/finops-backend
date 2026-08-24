import { randomUUID } from 'node:crypto';
import type {
  NormalizedFocusCostLineItem,
  NormalizedResourceMetricSample,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { Prisma as PrismaNamespace } from '../../generated/prisma/client.js';
import type { PrismaIngestionPersistenceClient } from './ingestionPersistenceTypes.js';
import {
  emptyResourceLinkageStats,
  summarizeResourceLinkage,
  type ResourceLinkageRunStats,
} from './ingestionResourceLinkage.js';
import { normalizeExternalResourceId, resolveExactResourceLink } from '../../domain/models/ResourceLinkage.js';

const METRIC_INSERT_BATCH_SIZE = 5_000;

/** Persists normalized FOCUS rows and technical samples with exact linkage. */
export class PrismaIngestionSamplePersistence {
  public async insertFocusRows(
    tx: PrismaIngestionPersistenceClient,
    rows: readonly NormalizedFocusCostLineItem[],
  ): Promise<number> {
    let inserted = 0;
    for (const chunk of chunkArray(rows, 1000)) {
      if (chunk.length === 0) continue;
      const result = await tx.focusCostLineItem.createMany({
        data: chunk.map((row) => this.focusRowData(row)),
        skipDuplicates: true,
      });
      inserted += result.count;
    }
    return inserted;
  }

  public async insertMetricSamples(
    tx: PrismaIngestionPersistenceClient,
    samples: readonly NormalizedResourceMetricSample[],
    resourceIdsByExternalId: ReadonlyMap<string, string>,
  ): Promise<ResourceLinkageRunStats> {
    if (samples.length === 0) return emptyResourceLinkageStats();

    const linkageRows: Array<{ readonly cloudResourceId?: string; readonly resourceLinkReason?: string }> = [];
    const data: PrismaNamespace.ResourceMetricSampleCreateManyInput[] = samples.map((sample) => {
        const normalizedExternalResourceId = normalizeExternalResourceId(sample.externalResourceId);
        const cloudResourceId = normalizedExternalResourceId === undefined
          ? undefined
          : resourceIdsByExternalId.get(normalizedExternalResourceId);
        const resourceLink = cloudResourceId === undefined
          ? resolveExactResourceLink({
              cloudConnectionId: sample.cloudConnectionId,
              externalResourceId: normalizedExternalResourceId,
              resourceIdsByKey: new Map(),
            })
          : { cloudResourceId };
        linkageRows.push({
          ...(resourceLink.cloudResourceId !== undefined ? { cloudResourceId: resourceLink.cloudResourceId } : {}),
          ...(resourceLink.reason !== undefined ? { resourceLinkReason: resourceLink.reason } : {}),
        });

        return {
          tenantId: sample.tenantId,
          cloudConnectionId: sample.cloudConnectionId,
          provider: sample.provider,
          externalResourceId: normalizedExternalResourceId ?? sample.externalResourceId,
          providerNamespace: sample.providerNamespace ?? '',
          regionId: sample.regionId ?? '',
          compartmentId: sample.compartmentId ?? '',
          dimensionsHash: sample.dimensionsHash ?? '',
          metricName: sample.metricName,
          statistic: sample.statistic ?? 'MEAN',
          value: new PrismaNamespace.Decimal(sample.value),
          sampledAt: sample.sampledAt,
          granularitySeconds: sample.granularitySeconds,
          sourceType: 'TECHNICAL_METRIC',
          ...(resourceLink.cloudResourceId !== undefined ? { cloudResourceId: resourceLink.cloudResourceId } : {}),
          ...(resourceLink.reason !== undefined ? { resourceLinkReason: resourceLink.reason } : {}),
          ...(sample.metricUnit !== undefined ? { metricUnit: sample.metricUnit } : {}),
          ...(sample.rawMetric !== undefined ? { rawMetric: sample.rawMetric as PrismaNamespace.InputJsonValue } : {}),
        };
      });
    for (const batch of chunkArray(data, METRIC_INSERT_BATCH_SIZE)) {
      if (batch.length === 0) continue;
      await insertMetricSampleBatch(tx, batch);
    }
    return summarizeResourceLinkage(linkageRows);
  }

  public async reconcileMetricSampleResourceLinks(
    tx: PrismaIngestionPersistenceClient,
    cloudConnectionId: string,
    resourceIdsByExternalId: ReadonlyMap<string, string>,
  ): Promise<void> {
    const pairs = [...resourceIdsByExternalId.entries()];
    for (const batch of chunkArray(pairs, 250)) {
      if (batch.length === 0) continue;
      await tx.$executeRaw(PrismaNamespace.sql`
        UPDATE "resource_metric_samples" AS samples
        SET "cloud_resource_id" = mapping.cloud_resource_id,
            "resource_link_reason" = NULL
        FROM (VALUES ${PrismaNamespace.join(batch.map(([externalResourceId, cloudResourceId]) => PrismaNamespace.sql`(${externalResourceId}, ${cloudResourceId})`))})
          AS mapping(external_resource_id, cloud_resource_id)
        WHERE samples."cloud_connection_id" = ${cloudConnectionId}
          AND samples."cloud_resource_id" IS NULL
          AND samples."external_resource_id" = mapping.external_resource_id
      `);
    }
  }

  /** Refreshes one row per native provider stream without loading the history into Node. */
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

  private focusRowData(row: NormalizedFocusCostLineItem): PrismaNamespace.FocusCostLineItemUncheckedCreateInput {
    return {
      tenantId: row.tenantId,
      cloudConnectionId: row.cloudConnectionId,
      provider: row.provider,
      focusVersion: row.focusVersion,
      chargePeriodStart: row.chargePeriodStart,
      chargePeriodEnd: row.chargePeriodEnd,
      ...(row.billingPeriodStart !== undefined ? { billingPeriodStart: row.billingPeriodStart } : {}),
      ...(row.billingPeriodEnd !== undefined ? { billingPeriodEnd: row.billingPeriodEnd } : {}),
      ...(row.billingAccountId !== undefined ? { billingAccountId: row.billingAccountId } : {}),
      ...(row.subAccountId !== undefined ? { subAccountId: row.subAccountId } : {}),
      serviceName: row.serviceName,
      resourceId: row.resourceId,
      ...(row.regionId !== undefined ? { regionId: row.regionId } : {}),
      chargeCategory: row.chargeCategory,
      billedCost: new PrismaNamespace.Decimal(row.billedCost),
      ...(row.effectiveCost !== undefined ? { effectiveCost: new PrismaNamespace.Decimal(row.effectiveCost) } : {}),
      ...(row.listCost !== undefined ? { listCost: new PrismaNamespace.Decimal(row.listCost) } : {}),
      ...(row.contractedCost !== undefined ? { contractedCost: new PrismaNamespace.Decimal(row.contractedCost) } : {}),
      billingCurrency: row.billingCurrency,
      ...(row.consumedQuantity !== undefined ? { consumedQuantity: new PrismaNamespace.Decimal(row.consumedQuantity) } : {}),
      ...(row.consumedUnit !== undefined ? { consumedUnit: row.consumedUnit } : {}),
      ...(row.tags !== undefined ? { tags: row.tags as PrismaNamespace.InputJsonValue } : {}),
      rawRow: row.rawRow as PrismaNamespace.InputJsonValue,
      lineItemHash: row.lineItemHash,
    };
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

/**
 * Inserts a metric batch in one PostgreSQL round trip.
 *
 * Technical samples are high-volume and their payload is already normalized
 * in memory. Using jsonb_to_recordset avoids Prisma generating one large
 * multi-value statement with hundreds of bound parameters while preserving
 * the same identity conflict semantics as createMany(skipDuplicates).
 */
async function insertMetricSampleBatch(
  tx: PrismaIngestionPersistenceClient,
  batch: readonly PrismaNamespace.ResourceMetricSampleCreateManyInput[],
): Promise<void> {
  const records = batch.map((row) => ({
    id: randomUUID(),
    tenant_id: row.tenantId,
    cloud_connection_id: row.cloudConnectionId,
    cloud_resource_id: row.cloudResourceId ?? null,
    resource_link_reason: row.resourceLinkReason ?? null,
    provider: row.provider,
    external_resource_id: row.externalResourceId,
    provider_namespace: row.providerNamespace ?? '',
    region_id: row.regionId ?? '',
    compartment_id: row.compartmentId ?? '',
    dimensions_hash: row.dimensionsHash ?? '',
    metric_name: row.metricName,
    metric_unit: row.metricUnit ?? null,
    statistic: row.statistic ?? 'MEAN',
    value: row.value?.toString() ?? '0',
    sampled_at: row.sampledAt,
    granularity_seconds: row.granularitySeconds ?? 1800,
    source_type: row.sourceType ?? 'TECHNICAL_METRIC',
    raw_metric: row.rawMetric ?? null,
  }));

  await tx.$executeRaw(PrismaNamespace.sql`
    INSERT INTO "resource_metric_samples" (
      "id", "tenant_id", "cloud_connection_id", "cloud_resource_id",
      "resource_link_reason", "provider", "external_resource_id",
      "provider_namespace", "region_id", "compartment_id", "dimensions_hash",
      "metric_name", "metric_unit", "statistic", "value", "sampled_at",
      "granularity_seconds", "source_type", "raw_metric"
    )
    SELECT
      payload.id,
      payload.tenant_id,
      payload.cloud_connection_id,
      payload.cloud_resource_id,
      payload.resource_link_reason,
      payload.provider::"CloudProvider",
      payload.external_resource_id,
      payload.provider_namespace,
      payload.region_id,
      payload.compartment_id,
      payload.dimensions_hash,
      payload.metric_name,
      payload.metric_unit,
      payload.statistic::"MetricStatistic",
      payload.value,
      payload.sampled_at,
      payload.granularity_seconds,
      payload.source_type::"IngestionSourceType",
      payload.raw_metric
    FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS payload(
      id text,
      tenant_id text,
      cloud_connection_id text,
      cloud_resource_id text,
      resource_link_reason text,
      provider text,
      external_resource_id text,
      provider_namespace text,
      region_id text,
      compartment_id text,
      dimensions_hash varchar(64),
      metric_name text,
      metric_unit text,
      statistic text,
      value numeric,
      sampled_at timestamptz,
      granularity_seconds integer,
      source_type text,
      raw_metric jsonb
    )
    ON CONFLICT (
      "cloud_connection_id", "provider_namespace", "region_id",
      "external_resource_id", "metric_name", "statistic",
      "granularity_seconds", "sampled_at", "dimensions_hash"
    ) DO NOTHING
  `);
}

function chunkArray<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

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
import { PrismaMetricStreamSummaryPersistence } from './PrismaMetricStreamSummaryPersistence.js';

const METRIC_INSERT_BATCH_SIZE = 5_000;

export interface MetricSamplePersistenceResult extends ResourceLinkageRunStats {
  readonly received: number;
  readonly inserted: number;
  readonly duplicates: number;
}

/** Persists normalized FOCUS rows and technical samples with exact linkage. */
export class PrismaIngestionSamplePersistence {
  private readonly streamSummaryPersistence = new PrismaMetricStreamSummaryPersistence();
  public async insertFocusRows(
    tx: PrismaIngestionPersistenceClient,
    rows: readonly NormalizedFocusCostLineItem[],
    ingestionJobId?: string,
  ): Promise<number> {
    let inserted = 0;
    for (const chunk of chunkArray(rows, 1000)) {
      if (chunk.length === 0) continue;
      const result = await tx.focusCostLineItem.createMany({
        data: chunk.map((row) => this.focusRowData(row, ingestionJobId)),
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
    ingestionJobId?: string,
  ): Promise<MetricSamplePersistenceResult> {
    if (samples.length === 0) return { ...emptyResourceLinkageStats(), received: 0, inserted: 0, duplicates: 0 };

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
          ...(ingestionJobId !== undefined ? { ingestionJobId } : {}),
        };
      });
    let inserted = 0;
    for (const batch of chunkArray(data, METRIC_INSERT_BATCH_SIZE)) {
      if (batch.length === 0) continue;
      inserted += await insertMetricSampleBatch(tx, batch);
    }
    return {
      ...summarizeResourceLinkage(linkageRows),
      received: samples.length,
      inserted,
      duplicates: Math.max(0, samples.length - inserted),
    };
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

  public refreshMetricStreamSummaries(
    tx: PrismaIngestionPersistenceClient,
    cloudConnectionId: string,
    samples: readonly NormalizedResourceMetricSample[],
    now = new Date(),
  ): Promise<void> {
    return this.streamSummaryPersistence.refreshMetricStreamSummaries(tx, cloudConnectionId, samples, now);
  }

  public refreshMetricStreamSummariesForJob(
    tx: PrismaIngestionPersistenceClient,
    ingestionJobId: string,
    now = new Date(),
  ): Promise<void> {
    return this.streamSummaryPersistence.refreshMetricStreamSummariesForJob(tx, ingestionJobId, now);
  }

  private focusRowData(row: NormalizedFocusCostLineItem, ingestionJobId?: string): PrismaNamespace.FocusCostLineItemUncheckedCreateInput {
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
      ...(ingestionJobId !== undefined ? { ingestionJobId } : {}),
    };
  }
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
): Promise<number> {
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
    ingestion_job_id: row.ingestionJobId ?? null,
  }));

  return tx.$executeRaw(PrismaNamespace.sql`
    INSERT INTO "resource_metric_samples" (
      "id", "tenant_id", "cloud_connection_id", "cloud_resource_id",
      "resource_link_reason", "provider", "external_resource_id",
      "provider_namespace", "region_id", "compartment_id", "dimensions_hash",
      "metric_name", "metric_unit", "statistic", "value", "sampled_at",
      "granularity_seconds", "source_type", "raw_metric", "ingestion_job_id"
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
      payload.raw_metric,
      payload.ingestion_job_id
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
      raw_metric jsonb,
      ingestion_job_id text
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

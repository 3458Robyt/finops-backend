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
    await tx.resourceMetricSample.createMany({
      data: samples.map((sample) => {
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
          metricName: sample.metricName,
          value: new PrismaNamespace.Decimal(sample.value),
          sampledAt: sample.sampledAt,
          granularitySeconds: sample.granularitySeconds,
          sourceType: 'TECHNICAL_METRIC',
          ...(resourceLink.cloudResourceId !== undefined ? { cloudResourceId: resourceLink.cloudResourceId } : {}),
          ...(resourceLink.reason !== undefined ? { resourceLinkReason: resourceLink.reason } : {}),
          ...(sample.metricUnit !== undefined ? { metricUnit: sample.metricUnit } : {}),
          ...(sample.rawMetric !== undefined ? { rawMetric: sample.rawMetric as PrismaNamespace.InputJsonValue } : {}),
        };
      }),
      skipDuplicates: true,
    });
    return summarizeResourceLinkage(linkageRows);
  }

  public async reconcileMetricSampleResourceLinks(
    tx: PrismaIngestionPersistenceClient,
    cloudConnectionId: string,
    resourceIdsByExternalId: ReadonlyMap<string, string>,
  ): Promise<void> {
    for (const [externalResourceId, cloudResourceId] of resourceIdsByExternalId) {
      await tx.resourceMetricSample.updateMany({
        where: { cloudConnectionId, externalResourceId, cloudResourceId: null },
        data: { cloudResourceId, resourceLinkReason: null },
      });
    }
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

function chunkArray<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

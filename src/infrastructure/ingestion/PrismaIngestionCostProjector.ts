import type {
  CloudIngestionJobContext,
  NormalizedFocusCostLineItem,
  NormalizedProviderCostLineItem,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import {
  normalizeExternalResourceId,
  resolveExactResourceLink,
} from '../../domain/models/ResourceLinkage.js';
import { CostBillingSource, Prisma } from '../../generated/prisma/client.js';
import {
  insertHistoricalCloudResources,
} from './PrismaCloudResourceCatalog.js';
import { buildHistoricalOciResources } from './oci/OciHistoricalResourceCatalog.js';
import {
  buildFocusCostMetricRows,
  getFocusCloudAccountExternalId,
  getFocusCloudAccountName,
} from './focusCostMetricProjection.js';
import type { PrismaIngestionPersistenceClient } from './ingestionPersistenceTypes.js';
import {
  emptyResourceLinkageStats,
  summarizeResourceLinkage,
  type ResourceLinkageRunStats,
} from './ingestionResourceLinkage.js';

export interface FocusCostMetricProjectionResult {
  readonly projected: number;
  readonly inserted: number;
  readonly linkage: ResourceLinkageRunStats;
  readonly historicalResourcesInserted?: number;
}

export class PrismaIngestionCostProjector {
  public async projectProviderCostsToCostMetrics(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
    rows: readonly NormalizedProviderCostLineItem[],
    resourceIdsByExternalId: ReadonlyMap<string, string>,
  ): Promise<FocusCostMetricProjectionResult> {
    if (rows.length === 0) return { projected: 0, inserted: 0, linkage: emptyResourceLinkageStats() };
    const resolvedResourceIds = await this.resolveResourceIdsForRows(tx, job, resourceIdsByExternalId, rows);
    const account = await tx.cloudAccount.upsert({
      where: { tenantId_provider_externalAccountId: { tenantId: job.tenantId, provider: rows[0]!.provider, externalAccountId: job.connection.rootExternalId } },
      update: { name: job.connection.rootExternalId, status: 'ACTIVE' },
      create: { tenantId: job.tenantId, provider: rows[0]!.provider, externalAccountId: job.connection.rootExternalId, name: job.connection.rootExternalId },
      select: { id: true },
    });
    await tx.costMetric.deleteMany({ where: { cloudConnectionId: job.cloudConnectionId, chargePeriodStart: { gte: job.targetStart, lt: job.targetEnd }, billingSource: CostBillingSource.FOCUS } });
    const data = rows.map((row) => {
      const normalizedResourceId = normalizeExternalResourceId(row.resourceId);
      const knownResourceId = normalizedResourceId === undefined ? undefined : resolvedResourceIds.get(normalizedResourceId);
      const resourceLink = knownResourceId === undefined
        ? resolveExactResourceLink({
          cloudConnectionId: row.cloudConnectionId,
          externalResourceId: normalizedResourceId,
          resourceIdsByKey: new Map(),
          serviceLevel: normalizedResourceId === undefined && !Object.prototype.hasOwnProperty.call(row.rawRow, 'ResourceId'),
        })
        : { cloudResourceId: knownResourceId };
      return {
        tenantId: row.tenantId, cloudAccountId: account.id, cloudConnectionId: row.cloudConnectionId,
        provider: row.provider, billingSource: CostBillingSource.PROVIDER_API,
        ...(row.billingAccountId === undefined ? {} : { billingAccountId: row.billingAccountId }),
        serviceName: row.serviceName, resourceId: row.resourceId,
        ...(resourceLink.cloudResourceId === undefined ? {} : { cloudResourceId: resourceLink.cloudResourceId }),
        ...(resourceLink.reason === undefined ? {} : { resourceLinkReason: resourceLink.reason }),
        ...(row.regionId === undefined ? {} : { regionId: row.regionId }),
        chargePeriodStart: row.chargePeriodStart, chargePeriodEnd: row.chargePeriodEnd,
        billedCost: row.billedCost, billingCurrency: row.billingCurrency, pricingCurrency: row.billingCurrency,
        ...(row.consumedQuantity === undefined ? {} : { consumedQuantity: row.consumedQuantity }),
        ...(row.consumedUnit === undefined ? {} : { consumedUnit: row.consumedUnit }),
        sourceMetric: row.sourceMetric, metricIdentityHash: row.lineItemHash,
        providerRaw: { source: 'PROVIDER_API', cloudConnectionId: row.cloudConnectionId, raw: row.rawRow } as Prisma.InputJsonValue,
      };
    });
    const result = await tx.costMetric.createMany({ data, skipDuplicates: true });
    return { projected: rows.length, inserted: result.count, linkage: summarizeResourceLinkage(data) };
  }

  public async projectFocusRowsToCostMetrics(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
    rows: readonly NormalizedFocusCostLineItem[],
    resourceIdsByExternalId: ReadonlyMap<string, string>,
  ): Promise<FocusCostMetricProjectionResult> {
    if (rows.length === 0) return { projected: 0, inserted: 0, linkage: emptyResourceLinkageStats() };
    const accountIdsByExternalId = await this.upsertFocusCloudAccounts(tx, job, rows);
    const historicalResourcesInserted = await insertHistoricalCloudResources(tx, buildHistoricalOciResources(job, rows));
    const resolvedResourceIds = await this.resolveResourceIdsForRows(tx, job, resourceIdsByExternalId, rows);
    await tx.costMetric.deleteMany({ where: { cloudConnectionId: job.cloudConnectionId, chargePeriodStart: { gte: job.targetStart, lt: job.targetEnd }, billingSource: CostBillingSource.PROVIDER_API } });
    const data = buildFocusCostMetricRows({ job, rows, accountIdsByExternalId, resourceIdsByExternalId: resolvedResourceIds });
    const result = await tx.costMetric.createMany({ data, skipDuplicates: true });
    return {
      projected: rows.length,
      inserted: result.count,
      linkage: summarizeResourceLinkage(data),
      historicalResourcesInserted,
    };
  }

  private async resolveResourceIdsForRows(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
    base: ReadonlyMap<string, string>,
    rows: readonly { readonly resourceId: string }[],
  ): Promise<ReadonlyMap<string, string>> {
    const externalResourceIds = [...new Set(rows.map((row) => normalizeExternalResourceId(row.resourceId)).filter((value): value is string => value !== undefined))];
    if (externalResourceIds.length === 0) return base;
    const persisted = await tx.cloudResource.findMany({
      where: { cloudConnectionId: job.cloudConnectionId, externalResourceId: { in: externalResourceIds } },
      select: { id: true, externalResourceId: true },
    });
    const resolved = new Map(base);
    for (const resource of persisted) resolved.set(resource.externalResourceId, resource.id);
    return resolved;
  }

  private async upsertFocusCloudAccounts(
    tx: PrismaIngestionPersistenceClient,
    job: CloudIngestionJobContext,
    rows: readonly NormalizedFocusCostLineItem[],
  ): Promise<ReadonlyMap<string, string>> {
    const samplesByExternalId = new Map<string, NormalizedFocusCostLineItem>();
    for (const row of rows) {
      const externalId = getFocusCloudAccountExternalId(job, row);
      if (!samplesByExternalId.has(externalId)) samplesByExternalId.set(externalId, row);
    }
    const accountIdsByExternalId = new Map<string, string>();
    for (const [externalId, row] of samplesByExternalId) {
      const account = await tx.cloudAccount.upsert({
        where: { tenantId_provider_externalAccountId: { tenantId: job.tenantId, provider: row.provider, externalAccountId: externalId } },
        update: { name: getFocusCloudAccountName(job, row), status: 'ACTIVE', ...(job.connection.defaultRegion === undefined ? {} : { defaultRegion: job.connection.defaultRegion }) },
        create: { tenantId: job.tenantId, provider: row.provider, externalAccountId: externalId, name: getFocusCloudAccountName(job, row), ...(job.connection.defaultRegion === undefined ? {} : { defaultRegion: job.connection.defaultRegion }) },
        select: { id: true },
      });
      accountIdsByExternalId.set(externalId, account.id);
    }
    return accountIdsByExternalId;
  }
}

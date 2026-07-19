import { createHash } from 'node:crypto';
import type {
  CloudIngestionJobContext,
  NormalizedFocusCostLineItem,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { CostBillingSource } from '../../generated/prisma/client.js';

export function getFocusCloudAccountExternalId(
  job: CloudIngestionJobContext,
  row: NormalizedFocusCostLineItem,
): string {
  return firstNonBlank(row.subAccountId, row.billingAccountId, job.connection.rootExternalId);
}

export function getFocusCloudAccountName(
  job: CloudIngestionJobContext,
  row: NormalizedFocusCostLineItem,
): string {
  return firstNonBlank(
    rawString(row, 'SubAccountName'),
    rawString(row, 'BillingAccountName'),
    getFocusCloudAccountExternalId(job, row),
  );
}

export function buildFocusCostMetricRows(input: {
  readonly job: CloudIngestionJobContext;
  readonly rows: readonly NormalizedFocusCostLineItem[];
  readonly accountIdsByExternalId: ReadonlyMap<string, string>;
}): Prisma.CostMetricCreateManyInput[] {
  return input.rows.map((row) => {
    const accountExternalId = getFocusCloudAccountExternalId(input.job, row);
    const cloudAccountId = input.accountIdsByExternalId.get(accountExternalId);
    if (cloudAccountId === undefined) {
      throw new Error(`Missing cloud account mapping for FOCUS account ${accountExternalId}`);
    }

    const billingAccountName = rawString(row, 'BillingAccountName');
    const subAccountName = rawString(row, 'SubAccountName');
    const serviceCategory = rawString(row, 'ServiceCategory');
    const resourceName = rawString(row, 'ResourceName');
    const resourceType = rawString(row, 'ResourceType');
    const regionName = rawString(row, 'RegionName');
    const availabilityZone = rawString(row, 'AvailabilityZone');
    const chargeClass = rawString(row, 'ChargeClass');
    const chargeFrequency = rawString(row, 'ChargeFrequency');
    const pricingQuantity = rawNumber(row, 'PricingQuantity');
    const pricingUnit = rawString(row, 'PricingUnit');

    return {
      tenantId: row.tenantId,
      cloudAccountId,
      cloudConnectionId: row.cloudConnectionId,
      provider: row.provider,
      billingSource: CostBillingSource.FOCUS,
      ...(row.billingAccountId !== undefined ? { billingAccountId: row.billingAccountId } : {}),
      ...(billingAccountName !== undefined ? { billingAccountName } : {}),
      ...(row.subAccountId !== undefined ? { subAccountId: row.subAccountId } : {}),
      ...(subAccountName !== undefined ? { subAccountName } : {}),
      serviceName: row.serviceName,
      ...(serviceCategory !== undefined ? { serviceCategory } : {}),
      resourceId: row.resourceId,
      ...(resourceName !== undefined ? { resourceName } : {}),
      ...(resourceType !== undefined ? { resourceType } : {}),
      ...(row.regionId !== undefined ? { regionId: row.regionId } : {}),
      ...(regionName !== undefined ? { regionName } : {}),
      ...(availabilityZone !== undefined ? { availabilityZone } : {}),
      chargeCategory: row.chargeCategory,
      ...(chargeClass !== undefined ? { chargeClass } : {}),
      ...(chargeFrequency !== undefined ? { chargeFrequency } : {}),
      chargePeriodStart: row.chargePeriodStart,
      chargePeriodEnd: row.chargePeriodEnd,
      ...(row.billingPeriodStart !== undefined ? { billingPeriodStart: row.billingPeriodStart } : {}),
      ...(row.billingPeriodEnd !== undefined ? { billingPeriodEnd: row.billingPeriodEnd } : {}),
      billedCost: row.billedCost,
      ...(row.effectiveCost !== undefined ? { effectiveCost: row.effectiveCost } : {}),
      ...(row.listCost !== undefined ? { listCost: row.listCost } : {}),
      ...(row.contractedCost !== undefined ? { contractedCost: row.contractedCost } : {}),
      billingCurrency: row.billingCurrency,
      pricingCurrency: rawString(row, 'PricingCurrency') ?? row.billingCurrency,
      ...(row.consumedQuantity !== undefined ? { consumedQuantity: row.consumedQuantity } : {}),
      ...(row.consumedUnit !== undefined ? { consumedUnit: row.consumedUnit } : {}),
      ...(pricingQuantity !== undefined ? { pricingQuantity } : {}),
      ...(pricingUnit !== undefined ? { pricingUnit } : {}),
      sourceMetric: 'FOCUSBilledCost',
      metricIdentityHash: buildFocusMetricIdentityHash(input.job, row),
      ...(row.tags !== undefined ? { tags: row.tags as Prisma.InputJsonValue } : {}),
      providerRaw: {
        source: 'FOCUS_EXPORT',
        focusVersion: row.focusVersion,
        cloudConnectionId: row.cloudConnectionId,
        lineItemHash: row.lineItemHash,
      } satisfies Prisma.InputJsonObject,
    };
  });
}

export function buildFocusMetricIdentityHash(
  job: CloudIngestionJobContext,
  row: NormalizedFocusCostLineItem,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      row.tenantId,
      row.cloudConnectionId,
      job.connection.rootExternalId,
      row.provider,
      row.focusVersion,
      row.chargePeriodStart.toISOString(),
      row.chargePeriodEnd.toISOString(),
      row.lineItemHash,
    ]))
    .digest('hex');
}

function rawString(row: NormalizedFocusCostLineItem, key: string): string | undefined {
  const value = row.rawRow[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function rawNumber(row: NormalizedFocusCostLineItem, key: string): number | undefined {
  const value = rawString(row, key);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNonBlank(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') {
      return value.trim();
    }
  }

  throw new Error('Expected at least one non-blank value');
}

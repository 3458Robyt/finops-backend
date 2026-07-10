import { describe, expect, it } from 'vitest';
import type {
  CloudIngestionJobContext,
  NormalizedFocusCostLineItem,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import { CloudProvider } from '../../generated/prisma/client.js';
import {
  buildFocusCostMetricRows,
  buildFocusMetricIdentityHash,
  getFocusCloudAccountExternalId,
  getFocusCloudAccountName,
} from './focusCostMetricProjection.js';

describe('focusCostMetricProjection', () => {
  it('projects FOCUS line items into cost_metrics rows with usage and account identity', () => {
    const job = buildJob();
    const row = buildFocusRow();
    const rows = buildFocusCostMetricRows({
      job,
      rows: [row],
      accountIdsByExternalId: new Map([['subaccount-1', 'cloud-account-1']]),
    });

    expect(getFocusCloudAccountExternalId(job, row)).toBe('subaccount-1');
    expect(getFocusCloudAccountName(job, row)).toBe('Produccion');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: 'tenant-1',
      cloudAccountId: 'cloud-account-1',
      provider: CloudProvider.OCI,
      billingAccountId: 'billing-1',
      billingAccountName: 'Cuenta raiz',
      subAccountId: 'subaccount-1',
      subAccountName: 'Produccion',
      serviceName: 'Compute',
      serviceCategory: 'Compute',
      resourceId: 'instance-1',
      resourceName: 'vm-1',
      resourceType: 'Compute Instance',
      regionId: 'sa-bogota-1',
      chargeCategory: 'Usage',
      billedCost: 12.34,
      effectiveCost: 10,
      billingCurrency: 'USD',
      pricingCurrency: 'USD',
      consumedQuantity: 24,
      consumedUnit: 'Hrs',
      pricingQuantity: 24,
      pricingUnit: 'Hrs',
      sourceMetric: 'FOCUSBilledCost',
    });
    expect(rows[0]?.metricIdentityHash).toBe(buildFocusMetricIdentityHash(job, row));
    expect(rows[0]?.providerRaw).toMatchObject({
      source: 'FOCUS_EXPORT',
      focusVersion: '1.0',
      cloudConnectionId: 'connection-1',
      lineItemHash: 'line-hash-1',
    });
  });

  it('falls back to the connection root account when FOCUS lacks subaccount and billing account', () => {
    const job = buildJob();
    const row = buildFocusRow({
      billingAccountId: undefined,
      subAccountId: undefined,
      rawRow: {},
    });

    expect(getFocusCloudAccountExternalId(job, row)).toBe('root-tenancy-1');
    expect(getFocusCloudAccountName(job, row)).toBe('root-tenancy-1');
  });
});

function buildJob(): CloudIngestionJobContext {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    sourceType: 'BILLING_EXPORT',
    targetStart: new Date('2026-06-01T00:00:00.000Z'),
    targetEnd: new Date('2026-06-02T00:00:00.000Z'),
    connection: {
      id: 'connection-1',
      tenantId: 'tenant-1',
      providerCode: 'oci',
      rootExternalId: 'root-tenancy-1',
      defaultRegion: 'sa-bogota-1',
      credentials: [],
    },
  };
}

function buildFocusRow(
  overrides: Partial<NormalizedFocusCostLineItem> = {},
): NormalizedFocusCostLineItem {
  return {
    tenantId: 'tenant-1',
    cloudConnectionId: 'connection-1',
    provider: CloudProvider.OCI,
    focusVersion: '1.0',
    chargePeriodStart: new Date('2026-06-01T00:00:00.000Z'),
    chargePeriodEnd: new Date('2026-06-02T00:00:00.000Z'),
    billingPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
    billingPeriodEnd: new Date('2026-06-30T00:00:00.000Z'),
    billingAccountId: 'billing-1',
    subAccountId: 'subaccount-1',
    serviceName: 'Compute',
    resourceId: 'instance-1',
    regionId: 'sa-bogota-1',
    chargeCategory: 'Usage',
    billedCost: 12.34,
    effectiveCost: 10,
    listCost: 14,
    billingCurrency: 'USD',
    consumedQuantity: 24,
    consumedUnit: 'Hrs',
    tags: { environment: 'prod' },
    rawRow: {
      BillingAccountName: 'Cuenta raiz',
      SubAccountName: 'Produccion',
      ServiceCategory: 'Compute',
      ResourceName: 'vm-1',
      ResourceType: 'Compute Instance',
      PricingQuantity: '24',
      PricingUnit: 'Hrs',
      PricingCurrency: 'USD',
    },
    lineItemHash: 'line-hash-1',
    ...overrides,
  };
}

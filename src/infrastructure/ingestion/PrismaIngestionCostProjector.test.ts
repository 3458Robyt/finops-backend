import { describe, expect, test, vi } from 'vitest';
import type { CloudIngestionJobContext, NormalizedProviderCostLineItem } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaIngestionPersistenceClient } from './ingestionPersistenceTypes.js';
import { PrismaIngestionCostProjector } from './PrismaIngestionCostProjector.js';

describe('PrismaIngestionCostProjector', () => {
  test('replaces provider-cost rows only inside the effective queried range', async () => {
    const requestedRange = {
      start: new Date('2026-09-20T02:00:00Z'),
      end: new Date('2026-09-20T03:00:00Z'),
    };
    const effectiveRange = {
      start: new Date('2026-09-19T00:00:00Z'),
      end: new Date('2026-09-20T00:00:00Z'),
    };
    const job = {
      id: 'job-1', tenantId: 'tenant-1', cloudConnectionId: 'connection-1',
      sourceType: 'BILLING_EXPORT', targetStart: requestedRange.start, targetEnd: requestedRange.end,
      connection: { id: 'connection-1', tenantId: 'tenant-1', providerCode: 'oci', rootExternalId: 'tenancy-1' },
    } as unknown as CloudIngestionJobContext;
    const row: NormalizedProviderCostLineItem = {
      tenantId: 'tenant-1', cloudConnectionId: 'connection-1', provider: 'OCI',
      chargePeriodStart: effectiveRange.start, chargePeriodEnd: effectiveRange.end,
      billingAccountId: 'tenancy-1', serviceName: 'Compute', resourceId: '', billedCost: 3,
      billingCurrency: 'USD', sourceMetric: 'OCI_COMPUTED_AMOUNT', rawRow: {}, lineItemHash: 'hash-1',
    };
    const deleteMany = vi.fn();
    const tx = {
      cloudResource: { findMany: vi.fn().mockResolvedValue([]) },
      cloudAccount: { upsert: vi.fn().mockResolvedValue({ id: 'account-1' }) },
      costMetric: { deleteMany, createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as PrismaIngestionPersistenceClient;

    await new PrismaIngestionCostProjector().projectProviderCostsToCostMetrics(
      tx, job, [row], new Map(), effectiveRange,
    );

    expect(deleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({
      chargePeriodStart: { gte: effectiveRange.start, lt: effectiveRange.end },
    }) });
  });
});

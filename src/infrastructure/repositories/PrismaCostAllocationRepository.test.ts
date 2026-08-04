import { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { PrismaCostAllocationRepository, summarize } from './PrismaCostAllocationRepository.js';
import type { CostAllocationRule } from '../../domain/models/CostAllocation.js';

const period = new Date('2026-05-01T00:00:00.000Z');
const rule = (id: string, priority: number, costCenter: string): CostAllocationRule => ({ id, tenantId: 'tenant-a', createdByUserId: 'user-a', name: id, priority, status: 'ACTIVE', allocationMode: 'DIRECT', allocationTargets: [], configurationVersion: 1, serviceName: 'Compute', costCenter, createdAt: period, updatedAt: period });
const metric = (currency: string, amount: string) => ({ billedCost: new Prisma.Decimal(amount), billingCurrency: currency, cloudAccountId: 'account-a', provider: 'AWS', serviceName: 'Compute', regionId: 'us-east-1', resourceId: 'resource-a', tags: {} });

describe('cost allocation summarization', () => {
  it('uses the first matching priority, never double-counts, and preserves currency boundaries', () => {
    const result = summarize([metric('USD', '10'), metric('COP', '100')], [rule('first', 1, 'CC-A'), rule('second', 2, 'CC-B')], period);
    expect(result).toHaveLength(2);
    expect(result.find((item) => item.currency === 'USD')).toMatchObject({ totalCost: 10, allocatedCost: 10, unallocatedCost: 0, dimensions: [{ allocationKey: 'CC-A', cost: 10 }] });
    expect(result.find((item) => item.currency === 'COP')).toMatchObject({ totalCost: 100, allocatedCost: 100, dimensions: [{ allocationKey: 'CC-A', cost: 100 }] });
  });
  it('marks metrics without a rule as UNALLOCATED', () => {
    expect(summarize([metric('USD', '10')], [], period)[0]).toMatchObject({ coveragePercent: 0, unallocatedCost: 10, dimensions: [{ allocationKey: 'UNALLOCATED', cost: 10 }] });
  });
  it('distributes shared cost with Decimal arithmetic and preserves the source total', () => {
    const split: CostAllocationRule = { ...rule('shared', 1, 'unused'), allocationMode: 'SPLIT', allocationTargets: [{ percentage: 33.3333, project: 'Platform' }, { percentage: 66.6667, project: 'Product' }] };
    const summary = summarize([metric('USD', '10.00')], [split], period)[0]!;
    expect(summary).toMatchObject({ totalCost: 10, allocatedCost: 10, sharedCost: 10, unallocatedCost: 0, coveragePercent: 100 });
    expect(summary.dimensions.reduce((sum, item) => sum + item.cost, 0)).toBe(10);
    expect(summary.dimensions.map((item) => item.allocationKey)).toEqual(['Product', 'Platform']);
  });
});

describe('cost allocation period closures', () => {
  it('is idempotent, preserves line evidence, and versions changed source data', async () => {
    const periodStart = new Date('2026-05-01T00:00:00.000Z');
    const metricRow = { ...metric('USD', '10.00'), chargePeriodStart: periodStart, metricIdentityHash: 'metric-1', cloudResourceId: 'canonical-resource-1', resourceLinkReason: 'INVENTORY_EXACT' };
    const ruleRow = { ...rule('compute-direct', 1, 'CC-PLATFORM'), allocationMode: 'DIRECT' as const, allocationTargets: [] };
    const metrics = [metricRow];
    const closures: any[] = [];
    const closureLineCounts = new Map<string, number>();
    const persistedLines: any[] = [];
    const budgetFindMany = vi.fn().mockResolvedValue([{ scopeKey: 'CC-PLATFORM', currency: 'USD', amount: new Prisma.Decimal('20.00') }]);
    const matches = (row: any, where: any) => (where.tenantId === undefined || row.tenantId === where.tenantId) && (where.periodStart === undefined || row.periodStart.getTime() === where.periodStart.getTime()) && (where.currency === undefined || row.currency === where.currency);
    const tx = {
      ingestionJob: { count: vi.fn().mockResolvedValue(0) },
      costAllocationRule: { findMany: vi.fn().mockResolvedValue([ruleRow]) },
      costMetric: { findMany: vi.fn().mockImplementation(async () => metrics) },
      costAllocationClosure: {
        findMany: vi.fn().mockImplementation(async ({ where }: any) => closures.filter((row) => matches(row, where))),
        create: vi.fn().mockImplementation(async ({ data }: any) => { const row = { id: `closure-${closures.length + 1}`, ...data, createdAt: new Date('2026-06-01T00:00:00.000Z') }; closures.push(row); return row; }),
        updateMany: vi.fn().mockImplementation(async ({ where, data }: any) => { let count = 0; for (const row of closures) if (matches(row, where) && (where.status === undefined || row.status === where.status)) { Object.assign(row, data); count += 1; } return { count }; }),
      },
      costAllocationClosureLine: {
        count: vi.fn().mockImplementation(async ({ where }: any) => closureLineCounts.get(where.closureId) ?? 0),
        createMany: vi.fn().mockImplementation(async ({ data }: any) => { const closureId = data[0]?.closureId as string; closureLineCounts.set(closureId, data.length); persistedLines.push(...data); return { count: data.length }; }),
      },
      budget: { findMany: budgetFindMany },
    };
    const prisma = { ...tx, $transaction: vi.fn().mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
    const valueRealization = { listDestinationSummary: vi.fn().mockResolvedValue([{ period: '2026-05', allocationKey: 'CC-PLATFORM', currency: 'USD', potentialSavings: 5, approvedSavings: 3, verifiedSavings: 1, observedSavings: 1, attributedRecommendations: 1 }]) };
    const repository = new PrismaCostAllocationRepository(prisma as any, valueRealization as any);

    const preview = await repository.preview('tenant-a', { name: 'preview', priority: 1, status: 'DRAFT', serviceName: 'Compute', costCenter: 'CC-PLATFORM', configurationHash: 'config-hash' }, periodStart);
    expect(preview.financialImpact.budgets).toMatchObject([{ allocationKey: 'CC-PLATFORM', budgetAmount: 20, projectedCost: 10, consumedPercent: 50 }]);
    expect(preview.financialImpact.savings).toMatchObject([{ currency: 'USD', potentialSavings: 5, verifiedSavings: 1 }]);

    const first = await repository.closePeriod('tenant-a', 'user-a', periodStart, true);
    expect(first[0]).toMatchObject({ version: 1, status: 'CLOSED', sourceTotal: 10, allocatedTotal: 10 });
    expect(persistedLines[0]).toMatchObject({ closureId: 'closure-1', cloudResourceId: 'canonical-resource-1', allocationKey: 'CC-PLATFORM' });
    expect(tx.costAllocationRule.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant-a', status: 'ACTIVE' }) }));

    const reused = await repository.closePeriod('tenant-a', 'user-a', periodStart, true);
    expect(reused[0]?.id).toBe(first[0]?.id);
    expect(closures).toHaveLength(1);

    metrics[0] = { ...metricRow, billedCost: new Prisma.Decimal('12.00') };
    await expect(repository.closePeriod('tenant-a', 'user-a', periodStart, true)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const corrected = await repository.closePeriod('tenant-a', 'user-a', periodStart, true, 'Costo tardío recibido');
    expect(corrected[0]).toMatchObject({ version: 2, status: 'CLOSED', sourceTotal: 12, replacementReason: 'Costo tardío recibido' });
    expect(closures[0]).toMatchObject({ version: 1, status: 'REPLACED', replacementReason: 'Costo tardío recibido' });
  });
});

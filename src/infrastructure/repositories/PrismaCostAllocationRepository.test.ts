import { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { summarize } from './PrismaCostAllocationRepository.js';
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

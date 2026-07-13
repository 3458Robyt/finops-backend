import { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { summarize } from './PrismaCostAllocationRepository.js';
import type { CostAllocationRule } from '../../domain/models/CostAllocation.js';

const period = new Date('2026-05-01T00:00:00.000Z');
const rule = (id: string, priority: number, costCenter: string): CostAllocationRule => ({ id, tenantId: 'tenant-a', createdByUserId: 'user-a', name: id, priority, status: 'ACTIVE', serviceName: 'Compute', costCenter, createdAt: period, updatedAt: period });
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
});

import { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import type { Budget } from '../../domain/models/Budget.js';
import { PrismaBudgetRepository } from './PrismaBudgetRepository.js';

describe('PrismaBudgetRepository allocation destinations', () => {
  it('reads destination actuals from the latest closed allocation without recalculating them', async () => {
    const findMany = vi.fn().mockResolvedValue([{
      id: 'closure-1', tenantId: 'tenant-1', periodStart: new Date('2026-07-01T00:00:00.000Z'), currency: 'USD', version: 1, status: 'CLOSED',
      sourceTotal: new Prisma.Decimal('30'), allocatedTotal: new Prisma.Decimal('30'), sharedTotal: new Prisma.Decimal('10'), unallocatedTotal: new Prisma.Decimal('0'),
      sourceHash: 'source', rulesHash: 'rules', results: [{ allocationKey: 'CC-PLATFORM', cost: 12.5 }], replacementReason: null,
      closedByUserId: 'user-1', createdAt: new Date('2026-08-01T00:00:00.000Z'),
    }]);
    const repository = new PrismaBudgetRepository({ costAllocationClosure: { findMany } } as any);
    const budget: Budget = {
      id: 'budget-1', tenantId: 'tenant-1', scope: 'ALLOCATION_DESTINATION', scopeKey: 'CC-PLATFORM', periodStart: new Date('2026-07-01T00:00:00.000Z'),
      amount: 20, currency: 'USD', warningThreshold: 0.8, criticalThreshold: 0.9, exceededThreshold: 1, status: 'ACTIVE', createdByUserId: 'user-1',
      createdAt: new Date('2026-07-01T00:00:00.000Z'), updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    await expect(repository.getActualCost(budget)).resolves.toBe(12.5);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-1', periodStart: budget.periodStart } }));
  });
});

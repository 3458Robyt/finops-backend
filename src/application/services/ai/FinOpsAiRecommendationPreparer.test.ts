import { describe, expect, it, vi } from 'vitest';

import type { CostAnalyticsSnapshot, ICostAnalyticsRepository } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsContextAssembler } from './finopsContextAssembler.js';
import { buildRecommendationReadinessReport } from './RecommendationReadinessGate.js';
import { FinOpsAiRecommendationPreparer } from './FinOpsAiRecommendationPreparer.js';

describe('FinOpsAiRecommendationPreparer', () => {
  it('selects the moving window without building a redundant monthly snapshot', async () => {
    const movingSnapshot = buildSnapshot({
      periodStart: '2026-08-16T12:00:00.000Z',
      periodEnd: '2026-09-15T12:00:00.000Z',
    });
    const getLatestTenantSnapshot = vi.fn(async () => buildSnapshot());
    const getLatestObservedThrough = vi.fn(async () => new Date('2026-09-15T12:00:00.000Z'));
    const getTenantSnapshotForPeriod = vi.fn(async () => movingSnapshot);
    const repository = {
      getLatestTenantSnapshot,
      getLatestObservedThrough,
      getTenantSnapshotForPeriod,
      getMonthlyCostSeries: vi.fn(async () => []),
      getMonthlyUsageSeries: vi.fn(async () => []),
    } as unknown as ICostAnalyticsRepository;
    const contextAssembler = {
      prepareRecommendationEvidence: vi.fn(async () => ({
        readinessReport: buildRecommendationReadinessReport({ snapshot: movingSnapshot }),
      })),
    } as unknown as FinOpsContextAssembler;

    const prepared = await new FinOpsAiRecommendationPreparer(
      repository,
      contextAssembler,
      'main-model',
      'auditor-model',
    ).prepare({ tenantId: movingSnapshot.tenantId });

    expect(getLatestObservedThrough).toHaveBeenCalledWith('tenant-1');
    expect(getTenantSnapshotForPeriod).toHaveBeenCalledWith(
      'tenant-1',
      new Date('2026-08-16T12:00:00.000Z'),
      new Date('2026-09-15T12:00:00.000Z'),
    );
    expect(getLatestTenantSnapshot).not.toHaveBeenCalled();
    expect(prepared.snapshot).toBe(movingSnapshot);
  });
});

function buildSnapshot(overrides: Partial<CostAnalyticsSnapshot> = {}): CostAnalyticsSnapshot {
  return {
    tenantId: 'tenant-1',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-10-01T00:00:00.000Z',
    totalCost: 100,
    currency: 'COP',
    metricCount: 10,
    providers: [],
    accounts: [],
    services: [],
    environments: [],
    topResources: [],
    ...overrides,
  };
}

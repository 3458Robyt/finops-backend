import { describe, expect, it, vi } from 'vitest';
import { PrismaValueRealizationRepository } from './PrismaValueRealizationRepository.js';

describe('PrismaValueRealizationRepository destination attribution', () => {
  it('maps only evidence-backed destination aggregates returned by SQL', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{
      period: '2026-07', allocation_key: 'CC-PLATFORM', currency: 'USD', potential_savings: 15.25, approved_savings: 10, verified_savings: 4.5, observed_savings: 3.75, attributed_recommendations: 2,
    }]);
    const repository = new PrismaValueRealizationRepository({ $queryRaw: queryRaw } as any);

    await expect(repository.listDestinationSummary({ tenantId: 'tenant-1', period: new Date('2026-07-20T00:00:00.000Z'), currency: 'USD' })).resolves.toEqual([{
      period: '2026-07', allocationKey: 'CC-PLATFORM', currency: 'USD', potentialSavings: 15.25, approvedSavings: 10, verifiedSavings: 4.5, observedSavings: 3.75, attributedRecommendations: 2,
    }]);
    expect(queryRaw).toHaveBeenCalledOnce();
  });
});

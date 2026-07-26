import { describe, expect, test } from 'vitest';
import { PrismaValueRealizationRepository } from '../infrastructure/repositories/PrismaValueRealizationRepository.js';
import { cleanupE2eFixtures, createE2eFixtures, createTestingPrismaClient } from './e2eFixtures.js';

describe('value realization PostgreSQL integration', () => {
  test('keeps portfolio tenant-scoped and supports summary, cursor page and export read model', async () => {
    if (process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true') return;
    const prisma = createTestingPrismaClient();
    const runId = `value-realization-${Date.now()}`;
    try {
      const fixtures = await createE2eFixtures(prisma, runId);
      const tenantId = fixtures.tenants[0]!.id;
      const otherTenantId = fixtures.tenants[1]!.id;
      const repository = new PrismaValueRealizationRepository(prisma);
      const fixtureRecommendation = await prisma.recommendation.findUniqueOrThrow({ where: { id: fixtures.recommendationIds[0]! } });

      const summary = await repository.getSummary({ tenantId });
      const firstPage = await repository.listItems({ tenantId, pageSize: 1 });
      const exported = await repository.listItemsForExport({ tenantId, pageSize: 10_000 });
      const otherSummary = await repository.getSummary({ tenantId: otherTenantId });

      expect(summary.counts.identified).toBe(1);
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.items[0]?.cloudAccountId).toBe(fixtureRecommendation.cloudAccountId);
      expect(exported).toHaveLength(1);
      expect(otherSummary.counts.identified).toBe(0);
    } finally {
      await cleanupE2eFixtures(prisma, runId);
      await prisma.$disconnect();
    }
  }, 60_000);
});

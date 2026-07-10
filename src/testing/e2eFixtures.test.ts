import { describe, expect, test } from 'vitest';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
} from './e2eFixtures.js';

describe('e2e fixture utilities', () => {
  test('create and cleanup isolated tenants in the configured database', async () => {
    if (process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true') {
      return;
    }

    const prisma = createTestingPrismaClient();
    const runId = `vitest-${Date.now()}`;

    try {
      const manifest = await createE2eFixtures(prisma, runId);

      expect(manifest.runId).toBe(runId);
      expect(manifest.tenants).toHaveLength(2);
      expect(manifest.admin.email).toContain(runId);
      expect(manifest.recommendationIds).toHaveLength(1);

      const tenantCount = await prisma.tenant.count({
        where: { slug: { startsWith: `e2e-finops-${runId}` } },
      });
      expect(tenantCount).toBe(2);

      const metricCount = await prisma.resourceMetricSample.count({
        where: { tenantId: manifest.tenants[0]?.id },
      });
      expect(metricCount).toBeGreaterThan(0);
    } finally {
      const deleted = await cleanupE2eFixtures(prisma, runId);
      await prisma.$disconnect();
      expect(deleted).toBeLessThanOrEqual(2);
    }
  }, 30_000);
});

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
} from './e2eFixtures.js';

afterEach(() => vi.unstubAllEnvs());

test('solo permite bases o esquemas de prueba explícitos', async () => {
  vi.stubEnv('ALLOW_DESTRUCTIVE_TEST_DATABASE', 'true');
  vi.stubEnv('DATABASE_URL', 'postgresql://redacted:placeholder@localhost/postgres');
  vi.stubEnv('TEST_DATABASE_URL', 'postgresql://redacted:placeholder@localhost/postgres');
  expect(() => createTestingPrismaClient()).toThrow(/must not equal/i);

  vi.stubEnv('TEST_DATABASE_URL', 'postgresql://redacted:placeholder@localhost/postgres?schema=public');
  expect(() => createTestingPrismaClient()).toThrow(/isolated finops_e2e/i);

  vi.stubEnv('TEST_DATABASE_URL', 'postgresql://redacted:placeholder@localhost/postgres?schema=finops_e2e_fixture');
  const prisma = createTestingPrismaClient();
  await prisma.$disconnect();
});

describe('e2e fixture utilities', () => {
  test.skipIf(process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true')('create and cleanup isolated tenants in the configured database', async () => {
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

      const recommendationId = manifest.recommendationIds[0];
      if (recommendationId === undefined) throw new Error('Fixture recommendation is required.');
      const recommendation = await prisma.recommendation.findUnique({
        where: { id: recommendationId },
        select: { evidence: true, estimatedMonthlySavings: true },
      });
      expect(recommendation?.estimatedMonthlySavings.toNumber()).toBe(0);
      expect(recommendation?.evidence).toMatchObject({
        deterministicRules: {
          readiness: 'GENERATABLE',
          evidenceStrength: 'HIGH',
          recommendedActionType: 'RIGHTSIZING',
          ruleMatches: expect.arrayContaining([
            'CPU_MODERATE_UNDERUTILIZATION',
            'MEMORY_LOW_UTILIZATION',
          ]),
          blockers: [],
          maxTechnicalSavingsRate: 0,
        },
        recommendationEvidenceSnapshot: {
          resources: [{
            ruleEvaluation: {
              readiness: 'GENERATABLE',
              evidenceStrength: 'HIGH',
              ruleMatches: expect.arrayContaining([
                'CPU_MODERATE_UNDERUTILIZATION',
                'MEMORY_LOW_UTILIZATION',
              ]),
              blockers: [],
            },
          }],
        },
      });
    } finally {
      const deleted = await cleanupE2eFixtures(prisma, runId);
      await prisma.$disconnect();
      expect(deleted).toBeLessThanOrEqual(2);
    }
  }, 30_000);
});

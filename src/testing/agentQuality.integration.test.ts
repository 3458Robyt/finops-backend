import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentQualityService } from '../application/services/AgentQualityService.js';
import { PrismaAgentQualityRepository } from '../infrastructure/repositories/PrismaAgentQualityRepository.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
  type E2eFixtureManifest,
} from './e2eFixtures.js';

const integrationEnabled = process.env['RUN_DB_INTEGRATION_TESTS'] === 'true';

describe.skipIf(!integrationEnabled)('AI quality calibration integration', () => {
  let prisma: ReturnType<typeof createTestingPrismaClient>;
  let fixtures: E2eFixtureManifest;

  beforeAll(async () => {
    prisma = createTestingPrismaClient();
    fixtures = await createE2eFixtures(prisma, `quality-${Date.now()}`);
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined && fixtures !== undefined) {
      await cleanupE2eFixtures(prisma, fixtures.runId);
      await prisma.$disconnect();
    }
  }, 120_000);

  it('keeps calibration rows tenant-scoped and exposes the fixture recommendation', async () => {
    const service = new AgentQualityService(new PrismaAgentQualityRepository(prisma));
    const tenantA = fixtures.tenants[0];
    const tenantB = fixtures.tenants[1];
    if (tenantA === undefined || tenantB === undefined) throw new Error('Fixture tenants are required.');

    const [reportA, reportB] = await Promise.all([
      service.getReport(tenantA.id, 30),
      service.getReport(tenantB.id, 30),
    ]);

    expect(reportA.totals.generated).toBeGreaterThanOrEqual(1);
    expect(reportA.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'TYPE', key: 'RIGHTSIZING' }),
      expect.objectContaining({ dimension: 'PROVIDER', key: 'OCI' }),
    ]));
    expect(reportB.totals.generated).toBe(0);
  });
});

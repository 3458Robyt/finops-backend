import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryRecommendationLearningContext } from '../infrastructure/repositories/queries/agentLearningSearchQueries.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
  type E2eFixtureManifest,
} from './e2eFixtures.js';

const integrationEnabled = process.env['RUN_DB_INTEGRATION_TESTS'] === 'true';

describe.skipIf(!integrationEnabled)('agent learning context integration', () => {
  let prisma: ReturnType<typeof createTestingPrismaClient>;
  let fixtures: E2eFixtureManifest;
  let globalFingerprint: string;

  beforeAll(async () => {
    prisma = createTestingPrismaClient();
    fixtures = await createE2eFixtures(prisma, `learning-context-${Date.now()}`);
    globalFingerprint = `integration-global-learning-${fixtures.runId}`;

    await prisma.agentMemory.createMany({
      data: [
        {
          scope: 'GLOBAL',
          memoryType: 'APPROVAL_PATTERN',
          content: 'Patrón global agregado para validar capacidad y reversibilidad.',
          confidence: 0.95,
          active: true,
          auditVerdict: 'APPROVED',
          auditScore: 95,
          auditReport: { verdict: 'APPROVED', score: 95 },
          fingerprint: globalFingerprint,
        },
        {
          scope: 'GLOBAL',
          memoryType: 'APPROVAL_PATTERN',
          content: 'Candidato global shadow que no debe entrar al contexto.',
          confidence: 0.99,
          active: false,
          auditVerdict: 'APPROVED',
          auditScore: 99,
          auditReport: { verdict: 'APPROVED', score: 99 },
          fingerprint: `${globalFingerprint}-shadow`,
        },
        {
          scope: 'LOCAL',
          tenantId: fixtures.tenants[1]?.id,
          memoryType: 'APPROVAL_PATTERN',
          content: 'Memoria local de otro tenant para comprobar aislamiento.',
          confidence: 1,
          active: true,
          auditVerdict: 'APPROVED',
          auditScore: 100,
          auditReport: { verdict: 'APPROVED', score: 100 },
          fingerprint: `${globalFingerprint}-other-tenant`,
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined && globalFingerprint !== undefined) {
      await prisma.agentMemory.deleteMany({
        where: { fingerprint: { startsWith: globalFingerprint } },
      });
    }
    if (prisma !== undefined && fixtures !== undefined) {
      await cleanupE2eFixtures(prisma, fixtures.runId);
      await prisma.$disconnect();
    }
  }, 120_000);

  it('includes active GLOBAL memories even when full-text does not match', async () => {
    const tenantId = fixtures.tenants[0]?.id;
    if (tenantId === undefined) throw new Error('Fixture tenant A is required.');

    const context = await queryRecommendationLearningContext(
      prisma,
      tenantId,
      'texto de proveedor que no aparece en el patrón global',
      10,
    );

    const memories = context.memories;
    expect(memories.some((memory) => memory.content.includes('Patrón global agregado'))).toBe(true);
    expect(memories.some((memory) => memory.content.includes('shadow'))).toBe(false);
    expect(memories.some((memory) => memory.content.includes('otro tenant'))).toBe(false);
    expect(memories.length).toBeGreaterThan(0);
  });
});

import { describe, expect, test } from 'vitest';

import { PrismaRecommendationAnalysisRunRepository } from '../infrastructure/repositories/PrismaRecommendationAnalysisRunRepository.js';
import { queueRecommendationAnalysisAfterIngestion } from '../infrastructure/repositories/PrismaRecommendationAnalysisScheduler.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
} from './e2eFixtures.js';

describe('recommendation analysis PostgreSQL integration', () => {
  test('claims once, isolates tenants, cancels, retries and links recommendations', async () => {
    if (process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true') return;

    const prisma = createTestingPrismaClient();
    const runId = `analysis-${Date.now()}`;
    try {
      const fixtures = await createE2eFixtures(prisma, runId);
      const tenantA = fixtures.tenants[0]!;
      const tenantB = fixtures.tenants[1]!;
      const user = await prisma.user.findFirstOrThrow({
        // This user is used to retry a run in tenant B. Select the explicit
        // cross-tenant operator fixture instead of relying on insertion order
        // between the MASTER_ADMIN and VIEWER rows.
        where: { tenantId: tenantA.id, role: 'MASTER_ADMIN' },
        select: { id: true },
      });
      const repository = new PrismaRecommendationAnalysisRunRepository(prisma);

      const first = await repository.queue({
        tenantId: tenantA.id,
        requestedByUserId: user.id,
        trigger: 'MANUAL',
        scope: 'TENANT',
      });
      const duplicate = await repository.queue({
        tenantId: tenantA.id,
        requestedByUserId: user.id,
        trigger: 'MANUAL',
        scope: 'TENANT',
      });
      expect(duplicate.reused).toBe(true);
      expect(duplicate.run.id).toBe(first.run.id);
      expect(await repository.findById(tenantB.id, first.run.id)).toBeNull();

      const second = await repository.queue({
        tenantId: tenantB.id,
        trigger: 'MANUAL',
        scope: 'TENANT',
      });
      const [claimA, claimB] = await Promise.all([
        repository.claimNext('worker-a', new Date(0)),
        repository.claimNext('worker-b', new Date(0)),
      ]);
      expect(new Set([claimA?.id, claimB?.id])).toEqual(new Set([first.run.id, second.run.id]));

      const claimedFirst = claimA?.id === first.run.id ? claimA : claimB;
      expect(claimedFirst?.workerId).toBeDefined();
      await repository.savePrepared(first.run.id, {
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        periodEnd: new Date('2026-07-01T00:00:00.000Z'),
        evidenceHash: 'integration-evidence',
        snapshot: { totalCost: 100 },
        readinessReport: { candidates: [{ id: 'candidate-1' }], blocked: [] },
        resourcesEvaluated: 1,
        candidatesFound: 1,
        candidatesSkipped: 0,
        candidateResults: [{
          candidateId: 'candidate-1',
          readiness: 'GENERATABLE',
          outcome: 'PUBLISHED',
          reasons: ['fixture'],
          recommendationId: fixtures.recommendationIds[0]!,
        }],
        model: 'fixture-generator',
        auditorModel: 'fixture-auditor',
      });
      const completed = await repository.complete(first.run.id, {
        status: 'COMPLETED',
        recommendationsGenerated: 1,
        recommendationsRejected: 0,
        candidateResults: [{
          candidateId: 'candidate-1',
          readiness: 'GENERATABLE',
          outcome: 'PUBLISHED',
          reasons: ['fixture'],
          recommendationId: fixtures.recommendationIds[0]!,
        }],
        recommendationLinks: [{
          recommendationId: fixtures.recommendationIds[0]!,
          candidateId: 'candidate-1',
          disposition: 'CREATED',
        }],
        promptTokenEstimate: 100,
        responseTokenEstimate: 50,
        latencyMs: 25,
      });
      expect(completed.recommendations).toEqual([
        expect.objectContaining({
          recommendationId: fixtures.recommendationIds[0],
          candidateId: 'candidate-1',
        }),
      ]);

      const pending = await repository.queue({
        tenantId: tenantA.id,
        requestedByUserId: user.id,
        trigger: 'MANUAL',
        scope: 'RESOURCE',
        externalResourceId: 'resource-to-cancel',
      });
      expect((await repository.cancelPending(tenantA.id, pending.run.id))?.status).toBe('CANCELLED');

      await prisma.recommendationAnalysisRun.update({
        where: { id: second.run.id },
        data: { status: 'FAILED', stage: 'FINISHED', completedAt: new Date() },
      });
      const retried = await repository.retryFailed(tenantB.id, second.run.id, user.id);
      expect(retried).toMatchObject({
        status: 'PENDING',
        trigger: 'RETRY',
        retriedFromRunId: second.run.id,
      });
      await repository.cancelPending(tenantB.id, retried.id);

      const stale = await repository.queue({
        tenantId: tenantA.id,
        requestedByUserId: user.id,
        trigger: 'MANUAL',
        scope: 'RESOURCE',
        externalResourceId: 'resource-from-stopped-worker',
      });
      await prisma.recommendationAnalysisRun.update({
        where: { id: stale.run.id },
        data: {
          status: 'RUNNING',
          stage: 'AI_GENERATION',
          workerId: 'worker-stopped',
          lockedAt: new Date('2026-01-01T00:00:00.000Z'),
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      expect(await repository.claimNext('worker-restarted', new Date())).toMatchObject({
        id: stale.run.id,
        status: 'RUNNING',
        workerId: 'worker-restarted',
      });

      const connection = await prisma.cloudConnection.findFirstOrThrow({
        where: { tenantId: tenantA.id },
        select: { id: true },
      });
      await prisma.ingestionJob.create({
        data: {
          tenantId: tenantA.id,
          cloudConnectionId: connection.id,
          sourceType: 'BILLING_EXPORT',
          status: 'SUCCESS',
          targetStart: new Date('2026-06-01T00:00:00.000Z'),
          targetEnd: new Date('2026-07-01T00:00:00.000Z'),
          completedAt: new Date(Date.now() + 100),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await queueRecommendationAnalysisAfterIngestion(prisma, repository, 0)).toBe(1);
      expect(await queueRecommendationAnalysisAfterIngestion(prisma, repository, 0)).toBe(0);
      expect((await repository.listByTenant(tenantA.id))[0]).toMatchObject({
        status: 'PENDING',
        trigger: 'POST_INGESTION',
      });
    } finally {
      await cleanupE2eFixtures(prisma, runId);
      await prisma.$disconnect();
    }
  }, 120_000);
});

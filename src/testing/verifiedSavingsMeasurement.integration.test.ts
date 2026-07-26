import { describe, expect, test } from 'vitest';
import { PrismaRecommendationRepository } from '../infrastructure/repositories/PrismaRecommendationRepository.js';
import {
  createSavingsMeasurement,
  findSavingsMeasurementsByRecommendation,
  verifySavingsMeasurement,
} from '../infrastructure/repositories/queries/recommendationSavingsMeasurementQueries.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
} from './e2eFixtures.js';

describe('verified savings PostgreSQL integration', () => {
  test('separates reported value, calculates comparable periods, is idempotent and verifies only the result', async () => {
    if (process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true') return;

    const prisma = createTestingPrismaClient();
    const runId = `savings-${Date.now()}`;
    try {
      const fixtures = await createE2eFixtures(prisma, runId);
      const tenantId = fixtures.tenants[0]!.id;
      const recommendationId = fixtures.recommendationIds[0]!;
      const user = await prisma.user.findFirstOrThrow({ where: { tenantId } });
      const recommendation = await prisma.recommendation.findUniqueOrThrow({
        where: { id: recommendationId },
        include: { executionPlans: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      const plan = recommendation.executionPlans[0]!;

      await prisma.recommendation.update({
        where: { id: recommendationId },
        data: {
          evidence: {
            e2eRunId: runId,
            scope: 'SERVICE',
            serviceName: 'Amazon Elastic Compute Cloud',
          },
        },
      });

      const costRows = await prisma.costMetric.findMany({
        where: { tenantId, chargePeriodStart: { gte: new Date('2026-05-09T00:00:00.000Z') } },
        orderBy: { chargePeriodStart: 'asc' },
      });
      await Promise.all(costRows.map((row) => prisma.costMetric.update({
        where: { chargePeriodStart_metricIdentityHash: {
          chargePeriodStart: row.chargePeriodStart,
          metricIdentityHash: row.metricIdentityHash,
        } },
        data: { billedCost: 4, effectiveCost: 4 },
      })));
      const lastCostRow = costRows.at(-1)!;
      const { createdAt: _createdAt, ...lastCostTemplate } = lastCostRow;
      await prisma.costMetric.create({
        data: {
          ...lastCostTemplate,
          chargePeriodStart: new Date('2026-05-15T00:00:00.000Z'),
          chargePeriodEnd: new Date('2026-05-16T00:00:00.000Z'),
          metricIdentityHash: `${runId}:cost:2026-05-15`,
        },
      });

      const execution = await prisma.recommendationManualExecution.create({
        data: {
          tenantId,
          recommendationId,
          executionPlanId: plan.id,
          userId: user.id,
          status: 'EXECUTED',
          executedAt: new Date('2026-05-08T12:00:00.000Z'),
          observedMonthlySavings: 999,
          currency: 'USD',
          notes: 'Valor reportado, no verificado.',
        },
      });

      const calculated = await createSavingsMeasurement(prisma, {
        tenantId,
        recommendationId,
        manualExecutionId: execution.id,
        executionPlanId: plan.id,
        requestedByUserId: user.id,
        windowDays: 7,
      });
      expect(calculated.status).toBe('CALCULATED');
      expect(calculated.calculationMethod).toBe('UNIT_NORMALIZED');
      expect(calculated.projectedMonthlySavings).toBeGreaterThan(0);
      expect(calculated.observedSavings).toBeGreaterThan(0);

      const sameEvidence = await createSavingsMeasurement(prisma, {
        tenantId,
        recommendationId,
        manualExecutionId: execution.id,
        requestedByUserId: user.id,
        windowDays: 7,
      });
      expect(sameEvidence.id).toBe(calculated.id);

      await prisma.costMetric.updateMany({
        where: { tenantId, chargePeriodStart: { gte: new Date('2026-05-09T00:00:00.000Z') } },
        data: { billedCost: 3, effectiveCost: 3 },
      });
      const recalculated = await createSavingsMeasurement(prisma, {
        tenantId,
        recommendationId,
        manualExecutionId: execution.id,
        requestedByUserId: user.id,
        windowDays: 7,
      });
      expect(recalculated.id).not.toBe(calculated.id);
      expect((await findSavingsMeasurementsByRecommendation(prisma, tenantId, recommendationId)).length).toBe(2);

      const verified = await verifySavingsMeasurement(prisma, {
        tenantId,
        recommendationId,
        measurementId: recalculated.id,
        userId: user.id,
        note: 'Ventanas comparables verificadas en fixture aislado.',
      });
      expect(verified.status).toBe('VERIFIED');

      const kpis = await new PrismaRecommendationRepository(prisma).getSavingsKpis(tenantId);
      expect(kpis.userReportedMonthlySavings).toBe(999);
      expect(kpis.verifiedMonthlySavings).toBeCloseTo(verified.projectedMonthlySavings ?? 0);
      expect(kpis.confirmedMonthlySavings).toBeCloseTo(verified.projectedMonthlySavings ?? 0);
    } finally {
      await cleanupE2eFixtures(prisma, runId);
      await prisma.$disconnect();
    }
  }, 60_000);
});

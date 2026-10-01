import { describe, expect, test } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaRecommendationLifecycleRepository } from '../infrastructure/repositories/PrismaRecommendationLifecycleRepository.js';
import { PrismaValueRealizationAllocationRepository } from '../infrastructure/repositories/PrismaValueRealizationAllocationRepository.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
} from './e2eFixtures.js';

describe('recommendation cost evidence PostgreSQL integration', () => {
  test.skipIf(process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true')(
    'snapshots exact rows, conserves savings, and fails closed on overlap or incomplete closures',
    async () => {
      const prisma = createTestingPrismaClient();
      const runId = `recommendation-evidence-${Date.now()}`;
      try {
        const fixtures = await createE2eFixtures(prisma, runId);
        const tenantId = fixtures.tenants[0]!.id;
        const sourceRows = await prisma.costMetric.findMany({
          where: { tenantId, cloudResourceId: fixtures.resourceIds[0]! },
          orderBy: { chargePeriodStart: 'asc' },
        });
        expect(sourceRows).toHaveLength(14);
        const first = sourceRows[0]!;
        const last = sourceRows.at(-1)!;
        const recommendationRepository =
          new PrismaRecommendationLifecycleRepository(prisma);
        await expect(
          recommendationRepository.createMany([
            {
              tenantId,
              cloudAccountId: first.cloudAccountId,
              cloudResourceId: fixtures.resourceIds[0]!,
              deduplicationKey: `${runId}-missing-scope`,
              type: 'RIGHTSIZING',
              severity: 'MEDIUM',
              title: 'Missing evidence scope',
              description: 'Must fail closed.',
              evidence: { candidateId: 'fixture-missing-scope' },
              estimatedMonthlySavings: 10,
              currency: first.billingCurrency,
            },
          ]),
        ).rejects.toMatchObject({ code: 'AI_EVIDENCE_RESOLUTION_FAILED' });
        await expect(
          prisma.recommendation.findUnique({
            where: {
              tenantId_deduplicationKey: {
                tenantId,
                deduplicationKey: `${runId}-missing-scope`,
              },
            },
          }),
        ).resolves.toBeNull();
        const scope = {
          provider: first.provider,
          cloudAccountId: first.cloudAccountId,
          cloudResourceId: fixtures.resourceIds[0]!,
          cloudConnectionId: first.cloudConnectionId ?? undefined,
          resourceId: first.resourceId,
          serviceName: first.serviceName,
          expectedMetricCount: sourceRows.length,
          periodStart: first.chargePeriodStart.toISOString(),
          periodEnd: new Date(
            last.chargePeriodStart.getTime() + 86_400_000,
          ).toISOString(),
        };
        const recommendations = await recommendationRepository.createMany(
          [100, 50].map((savings) => ({
            tenantId,
            cloudAccountId: first.cloudAccountId,
            cloudResourceId: fixtures.resourceIds[0]!,
            deduplicationKey: `${runId}-${savings}`,
            type: 'RIGHTSIZING',
            origin: 'AI_GENERATED' as const,
            severity: 'MEDIUM' as const,
            title: `Evidence test ${savings}`,
            description:
              'Fixture-only recommendation for evidence attribution.',
            evidence: { candidateId: `fixture-${savings}` },
            estimatedMonthlySavings: savings,
            currency: first.billingCurrency,
            costEvidenceScope: scope,
          })),
        );
        expect(
          await prisma.recommendationCostEvidence.count({
            where: { tenantId },
          }),
        ).toBe(28);
        const [runtimePrivileges] = await prisma.$queryRaw<
          Array<{
            canSelect: boolean;
            canInsert: boolean;
            canUpdate: boolean;
            canDelete: boolean;
          }>
        >(Prisma.sql`
          SELECT
            has_table_privilege('finops_runtime', 'recommendation_cost_evidence', 'SELECT') AS "canSelect",
            has_table_privilege('finops_runtime', 'recommendation_cost_evidence', 'INSERT') AS "canInsert",
            has_table_privilege('finops_runtime', 'recommendation_cost_evidence', 'UPDATE') AS "canUpdate",
            has_table_privilege('finops_runtime', 'recommendation_cost_evidence', 'DELETE') AS "canDelete"
        `);
        expect(runtimePrivileges).toEqual({
          canSelect: true,
          canInsert: true,
          canUpdate: false,
          canDelete: false,
        });
        const otherTenantId = fixtures.tenants[1]!.id;
        await expect(
          prisma.recommendationCostEvidence.create({
            data: {
              tenantId: otherTenantId,
              recommendationId: recommendations[0]!.id,
              cloudAccountId: first.cloudAccountId,
              cloudResourceId: fixtures.resourceIds[0]!,
              provider: first.provider,
              resourceId: first.resourceId,
              serviceName: first.serviceName,
              chargePeriodStart: first.chargePeriodStart,
              metricIdentityHash: first.metricIdentityHash,
              billingCurrency: first.billingCurrency,
              billedCost: first.billedCost,
            },
          }),
        ).rejects.toThrow(/Tenant relationship violation/);

        const user = await prisma.user.findFirstOrThrow({
          where: { email: fixtures.admin.email },
        });
        const monthStart = new Date(
          Date.UTC(
            first.chargePeriodStart.getUTCFullYear(),
            first.chargePeriodStart.getUTCMonth(),
            1,
          ),
        );
        const nextMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
        const periodRows = sourceRows.filter((row) => row.chargePeriodStart >= monthStart && row.chargePeriodStart < nextMonth);
        expect(periodRows.length).toBeGreaterThan(1);
        await createClosure(
          prisma,
          tenantId,
          user.id,
          monthStart,
          periodRows,
          1,
        );
        const allocations = new PrismaValueRealizationAllocationRepository(
          prisma,
        );
        const summary = await allocations.listDestinationSummary({
          tenantId,
          period: monthStart,
          currency: first.billingCurrency,
        });
        const destinationA = summary.find(
          (item) => item.allocationKey === 'DEST-A',
        );
        const destinationB = summary.find(
          (item) => item.allocationKey === 'DEST-B',
        );
        expect(destinationA?.potentialSavings).toBeCloseTo(60, 5);
        expect(destinationB?.potentialSavings).toBeCloseTo(40, 5);
        expect(destinationA?.attributedRecommendations).toBe(1);
        expect(destinationB?.attributedRecommendations).toBe(1);

        await createClosure(
          prisma,
          tenantId,
          user.id,
          monthStart,
          periodRows.slice(0, -1),
          2,
        );
        await expect(
          allocations.listDestinationSummary({
            tenantId,
            period: monthStart,
            currency: first.billingCurrency,
          }),
        ).resolves.toEqual([]);

        await prisma.recommendation.create({
          data: {
            tenantId,
            cloudAccountId: first.cloudAccountId,
            cloudResourceId: fixtures.resourceIds[0]!,
            sourceChargePeriodStart: periodRows.at(-1)!.chargePeriodStart,
            sourceMetricIdentityHash: periodRows.at(-1)!.metricIdentityHash,
            type: 'RIGHTSIZING',
            origin: 'LEGACY_UNKNOWN',
            status: 'APPROVED',
            severity: 'MEDIUM',
            title: 'Legacy evidence compatibility',
            description: 'Fixture to preserve singular historical evidence.',
            estimatedMonthlySavings: new Prisma.Decimal(200),
            currency: first.billingCurrency,
            evidence: {},
          },
        });
        await createClosure(
          prisma,
          tenantId,
          user.id,
          monthStart,
          periodRows,
          3,
        );
        const legacySummary = await allocations.listDestinationSummary({
          tenantId,
          period: monthStart,
          currency: first.billingCurrency,
        });
        expect(legacySummary.find((item) => item.allocationKey === 'DEST-A')?.potentialSavings)
          .toBeCloseTo(120, 5);
        expect(legacySummary.find((item) => item.allocationKey === 'DEST-B')?.potentialSavings)
          .toBeCloseTo(80, 5);

        await createClosure(
          prisma,
          tenantId,
          user.id,
          monthStart,
          periodRows.slice(0, -1),
          4,
        );
        await expect(
          allocations.listDestinationSummary({
            tenantId,
            period: monthStart,
            currency: first.billingCurrency,
          }),
        ).resolves.toEqual([]);
        expect(recommendations).toHaveLength(2);
      } finally {
        await cleanupE2eFixtures(prisma, runId);
        await prisma.$disconnect();
      }
    },
    60_000,
  );
});

async function createClosure(
  prisma: ReturnType<typeof createTestingPrismaClient>,
  tenantId: string,
  userId: string,
  periodStart: Date,
  metrics: readonly Prisma.CostMetricGetPayload<object>[],
  version: number,
): Promise<void> {
  const sourceTotal = metrics.reduce(
    (sum, metric) => sum.add(metric.billedCost),
    new Prisma.Decimal(0),
  );
  const closure = await prisma.costAllocationClosure.create({
    data: {
      tenantId,
      periodStart,
      currency: metrics[0]!.billingCurrency,
      version,
      status: 'CLOSED',
      sourceTotal,
      allocatedTotal: sourceTotal,
      sharedTotal: 0,
      unallocatedTotal: 0,
      sourceHash: String(version).repeat(64),
      rulesHash: 'a'.repeat(64),
      results: {},
      closedByUserId: userId,
    },
  });
  await prisma.costAllocationClosureLine.createMany({
    data: metrics.flatMap((metric, index) => {
      const sourceAmount = metric.billedCost;
      const firstShare = sourceAmount.mul(0.6);
      const secondShare = sourceAmount.minus(firstShare);
      return [
        ['DEST-A', firstShare],
        ['DEST-B', secondShare],
      ].map(([allocationKey, allocationAmount], targetIndex) => ({
        id: `evidence-${version}-${index}-${targetIndex}-${tenantId}`,
        tenantId,
        closureId: closure.id,
        chargePeriodStart: metric.chargePeriodStart,
        metricIdentityHash: metric.metricIdentityHash,
        currency: metric.billingCurrency,
        sourceAmount,
        allocationAmount: allocationAmount as Prisma.Decimal,
        allocationKey: allocationKey as string,
        allocationMode: 'DIRECT' as const,
        shared: false,
        cloudAccountId: metric.cloudAccountId,
        provider: metric.provider,
        serviceName: metric.serviceName,
        ...(metric.resourceId === '' ? {} : { resourceId: metric.resourceId }),
        ...(metric.cloudResourceId === null
          ? {}
          : { cloudResourceId: metric.cloudResourceId }),
      }));
    }),
  });
}

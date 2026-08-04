import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthContext } from '../domain/models/AuthContext.js';
import type { Budget } from '../domain/models/Budget.js';
import { Prisma } from '../generated/prisma/client.js';
import { CostAllocationService } from '../application/services/CostAllocationService.js';
import { PrismaBudgetRepository } from '../infrastructure/repositories/PrismaBudgetRepository.js';
import { PrismaCostAllocationRepository } from '../infrastructure/repositories/PrismaCostAllocationRepository.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
  type E2eFixtureManifest,
} from './e2eFixtures.js';

const integrationEnabled = process.env['RUN_DB_INTEGRATION_TESTS'] === 'true';

describe.skipIf(!integrationEnabled)('shared cost allocation PostgreSQL integration', () => {
  let prisma: ReturnType<typeof createTestingPrismaClient>;
  let fixtures: E2eFixtureManifest;
  let service: CostAllocationService;
  let actor: AuthContext;

  beforeAll(async () => {
    prisma = createTestingPrismaClient();
    fixtures = await createE2eFixtures(prisma, `cost-allocation-${Date.now().toString(36)}`);
    const user = await prisma.user.findFirstOrThrow({ where: { email: fixtures.admin.email } });
    actor = { userId: user.id, tenantId: fixtures.tenants[0]!.id, email: user.email, role: user.role, jwtId: `integration-${fixtures.runId}` } as AuthContext;
    service = new CostAllocationService(new PrismaCostAllocationRepository(prisma));
  }, 120_000);

  afterAll(async () => {
    try {
      if (prisma !== undefined && fixtures !== undefined) await cleanupE2eFixtures(prisma, fixtures.runId);
    } finally {
      await prisma?.$disconnect();
    }
  }, 120_000);

  it('runs costs → rule → preview → activation → closure and preserves idempotency', async () => {
    const period = fixtures.billingPeriod;
    const ruleInput = { name: `Direct ${fixtures.runId}`, priority: 1, status: 'DRAFT' as const, serviceName: 'Amazon Elastic Compute Cloud', costCenter: 'CC-PLATFORM' };
    const rule = await service.createRule(actor, ruleInput);
    await prisma.budget.create({ data: { tenantId: actor.tenantId, scope: 'ALLOCATION_DESTINATION', scopeKey: 'CC-PLATFORM', periodStart: new Date(`${period}-01T00:00:00.000Z`), amount: 1_000, currency: 'USD', createdByUserId: actor.userId } });
    const destinationBudget = { tenantId: actor.tenantId, scope: 'ALLOCATION_DESTINATION', scopeKey: 'CC-PLATFORM', periodStart: new Date(`${period}-01T00:00:00.000Z`), currency: 'USD' } as Budget;
    const budgetRepository = new PrismaBudgetRepository(prisma);
    await expect(budgetRepository.getActualCost(destinationBudget)).resolves.toEqual({ amount: 0, available: false, source: 'NO_CLOSED_ALLOCATION' });

    const preview = await service.preview(actor, ruleInput, period, rule.id);
    expect(preview.metricCount).toBeGreaterThan(0);
    expect(preview.summary.every((summary) => summary.totalCost === summary.allocatedCost + summary.unallocatedCost)).toBe(true);
    expect(preview.financialImpact.budgets).toEqual(expect.arrayContaining([expect.objectContaining({ allocationKey: 'CC-PLATFORM', currency: 'USD' })]));

    const active = await service.activateRule(actor, rule.id);
    expect(active.status).toBe('ACTIVE');
    expect(active.configurationVersion).toBe(1);
    expect(active.lastPreviewedHash).toBe(active.configurationHash);

    const first = await service.closePeriod(actor, { period, confirmUnallocated: true });
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((closure) => closure.sourceTotal === closure.allocatedTotal + closure.unallocatedTotal)).toBe(true);
    const destinationActual = await budgetRepository.getActualCost(destinationBudget);
    expect(destinationActual.available).toBe(true);
    expect(destinationActual.source).toBe('CLOSED_ALLOCATION');
    const second = await service.closePeriod(actor, { period, confirmUnallocated: true });
    expect(second.map((closure) => closure.id)).toEqual(first.map((closure) => closure.id));
    expect(await prisma.costAllocationClosureLine.count({ where: { tenantId: actor.tenantId } })).toBeGreaterThan(0);
  }, 120_000);

  it('rejects cross-tenant closure-line references and direct mutation of closed evidence', async () => {
    const tenantId = actor.tenantId;
    const closure = await prisma.costAllocationClosure.findFirstOrThrow({ where: { tenantId, status: 'CLOSED' } });
    const otherTenant = fixtures.tenants[1]!.id;
    await expect(prisma.$executeRaw`
      INSERT INTO cost_allocation_closure_lines
        (id, tenant_id, closure_id, charge_period_start, metric_identity_hash, currency,
         source_amount, allocation_amount, allocation_key, allocation_mode, shared,
         cloud_account_id, provider, service_name)
      VALUES
        (${`cross-${fixtures.runId}`}, ${otherTenant}, ${closure.id}, ${closure.periodStart},
         ${`cross-${fixtures.runId}`}, 'USD', 1, 1, 'CROSS', 'DIRECT', false,
         'cross-account', 'OCI', 'Cross tenant')
    `).rejects.toThrow();
    await expect(prisma.$executeRaw`
      UPDATE cost_allocation_closures
      SET source_total = source_total + 1
      WHERE id = ${closure.id}
    `).rejects.toThrow();
  }, 120_000);

  it('measures preview and closure with 10,000 persisted cost records', async () => {
    const period = '2025-01';
    const periodStart = new Date('2025-01-01T00:00:00.000Z');
    const sample = await prisma.costMetric.findFirstOrThrow({
      where: { tenantId: actor.tenantId },
      select: {
        cloudAccountId: true,
        cloudConnectionId: true,
        cloudResourceId: true,
        provider: true,
        resourceId: true,
        resourceName: true,
        regionId: true,
      },
    });
    const runId = `cost-allocation-perf-${Date.now().toString(36)}`;
    const serviceName = 'Cost Allocation Benchmark';
    await prisma.costMetric.createMany({
      data: Array.from({ length: 10_000 }, (_, index) => {
        const chargePeriodStart = new Date(periodStart);
        chargePeriodStart.setUTCDate(chargePeriodStart.getUTCDate() + (index % 28));
        const chargePeriodEnd = new Date(chargePeriodStart);
        chargePeriodEnd.setUTCDate(chargePeriodEnd.getUTCDate() + 1);
        const amount = new Prisma.Decimal(String((index % 25) + 1));
        return {
          tenantId: actor.tenantId,
          cloudAccountId: sample.cloudAccountId,
          ...(sample.cloudConnectionId === null ? {} : { cloudConnectionId: sample.cloudConnectionId }),
          ...(sample.cloudResourceId === null ? {} : { cloudResourceId: sample.cloudResourceId }),
          provider: sample.provider,
          serviceName,
          resourceId: sample.resourceId,
          ...(sample.resourceName === null ? {} : { resourceName: sample.resourceName }),
          ...(sample.regionId === null ? {} : { regionId: sample.regionId }),
          chargePeriodStart,
          chargePeriodEnd,
          billingPeriodStart: periodStart,
          billingPeriodEnd: new Date('2025-02-01T00:00:00.000Z'),
          billedCost: amount,
          effectiveCost: amount,
          billingCurrency: 'USD',
          pricingCurrency: 'USD',
          consumedQuantity: new Prisma.Decimal(1),
          consumedUnit: 'Hours',
          pricingQuantity: new Prisma.Decimal(1),
          pricingUnit: 'Hours',
          sourceMetric: 'E2E_PERF',
          metricIdentityHash: `${runId}:${index}`,
          tags: { e2eRunId: fixtures.runId, perfRunId: runId },
          providerRaw: { fixture: true, benchmark: true },
        };
      }),
    });
    const explainRows = await prisma.$queryRaw<readonly { readonly ['QUERY PLAN']: unknown }[]>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "metric_identity_hash"
      FROM "cost_metrics"
      WHERE "tenant_id" = ${actor.tenantId}
        AND "charge_period_start" >= ${periodStart}
        AND "charge_period_start" < ${new Date('2025-02-01T00:00:00.000Z')}
    `;
    console.info(`[cost-allocation-explain] ${JSON.stringify(explainRows).slice(0, 2_000)}`);

    const ruleInput = {
      name: `Performance ${runId}`,
      priority: 1,
      status: 'DRAFT' as const,
      serviceName,
      costCenter: 'CC-PERF',
    };
    const rule = await service.createRule(actor, ruleInput);
    const previewStartedAt = performance.now();
    const preview = await service.preview(actor, ruleInput, period, rule.id);
    const previewMs = performance.now() - previewStartedAt;
    expect(preview.metricCount).toBe(10_000);
    expect(preview.summary.every((summary) => summary.totalCost === summary.allocatedCost + summary.unallocatedCost)).toBe(true);

    await service.activateRule(actor, rule.id);
    const closureStartedAt = performance.now();
    const closures = await service.closePeriod(actor, { period, confirmUnallocated: true });
    const closureMs = performance.now() - closureStartedAt;
    expect(closures).toHaveLength(1);
    expect(closures[0]!.sourceTotal).toBe(closures[0]!.allocatedTotal + closures[0]!.unallocatedTotal);
    expect(await prisma.costAllocationClosureLine.count({ where: { tenantId: actor.tenantId, closureId: closures[0]!.id } })).toBe(10_000);
    console.info(`[cost-allocation-perf] records=10000 previewMs=${previewMs.toFixed(2)} closureMs=${closureMs.toFixed(2)}`);
    if (process.env['ENFORCE_COST_ALLOCATION_PERF'] === 'true') {
      expect(previewMs).toBeLessThanOrEqual(500);
      expect(closureMs).toBeLessThanOrEqual(2_000);
    }
  }, 120_000);
});

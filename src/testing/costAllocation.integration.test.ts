import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthContext } from '../domain/models/AuthContext.js';
import { CostAllocationService } from '../application/services/CostAllocationService.js';
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
});

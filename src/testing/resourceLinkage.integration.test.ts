import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildResourceFreshness,
  classifyResourceEvidenceStatus,
  resolveExactResourceLink,
  resourceLookupKey,
} from '../domain/models/ResourceLinkage.js';
import { PrismaResourceLinkageReadinessRepository } from '../infrastructure/repositories/PrismaResourceLinkageReadinessRepository.js';
import { PrismaResourceMetricRepository } from '../infrastructure/repositories/PrismaResourceMetricRepository.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
  type E2eFixtureManifest,
} from './e2eFixtures.js';
import { Prisma } from '../generated/prisma/client.js';

const integrationEnabled = process.env['RUN_DB_INTEGRATION_TESTS'] === 'true';

describe.skipIf(!integrationEnabled)('normalized resource lineage integration', () => {
  let prisma: ReturnType<typeof createTestingPrismaClient>;
  let fixtures: E2eFixtureManifest;

  beforeAll(async () => {
    prisma = createTestingPrismaClient();
    fixtures = await createE2eFixtures(prisma, `resource-lineage-${Date.now().toString(36)}`);
  }, 120_000);

  afterAll(async () => {
    try {
      if (prisma !== undefined && fixtures !== undefined) {
        await cleanupE2eFixtures(prisma, fixtures.runId);
      }
    } finally {
      await prisma?.$disconnect();
    }
  }, 120_000);

  it('reports linked evidence, freshness and per-connection readiness', async () => {
    const tenantId = fixtures.tenants[0]!.id;
    const resourceId = fixtures.resourceIds[0]!;
    const connection = await prisma.cloudConnection.findFirstOrThrow({ where: { tenantId }, select: { id: true } });
    await prisma.resourceMetricSample.create({
      data: {
        tenantId,
        cloudConnectionId: connection.id,
        cloudResourceId: resourceId,
        provider: 'AWS',
        externalResourceId: `i-${fixtures.runId.slice(0, 8)}`,
        metricName: 'ReadinessCanary',
        metricUnit: '%',
        value: new Prisma.Decimal(12),
        sampledAt: new Date(),
        granularitySeconds: 1800,
        sourceType: 'TECHNICAL_METRIC',
      },
    });

    const readiness = await new PrismaResourceLinkageReadinessRepository(prisma).getForTenant(tenantId, 10);
    expect(readiness.inventoryResources).toBeGreaterThan(0);
    expect(readiness.costs.linked).toBeGreaterThan(0);
    expect(readiness.metrics.linked).toBeGreaterThan(0);
    expect(readiness.connections).toHaveLength(1);
    expect(readiness.resources[0]?.evidenceStatus).toBe('EVIDENCE_COMPLETE');
    expect(readiness.resources[0]?.freshness.inventory.status).toBe('FRESH');
    expect(readiness.technicalRecommendationBlockers).not.toContain('NO_NORMALIZED_INVENTORY');
  }, 120_000);

  it('resolves the same external id independently per connection', async () => {
    const tenantId = fixtures.tenants[0]!.id;
    const original = await prisma.cloudResource.findFirstOrThrow({ where: { tenantId } });
    const secondConnection = await prisma.cloudConnection.create({
      data: {
        tenantId,
        providerCode: 'aws',
        rootExternalId: `second-${fixtures.runId}`,
        name: `Second connection ${fixtures.runId}`,
        status: 'ACTIVE',
      },
    });
    const secondResource = await prisma.cloudResource.create({
      data: {
        tenantId,
        cloudConnectionId: secondConnection.id,
        provider: 'AWS',
        externalResourceId: original.externalResourceId,
        resourceType: original.resourceType,
        serviceName: original.serviceName,
        status: 'ACTIVE',
      },
    });

    const links = new Map([
      [resourceLookupKey(original.cloudConnectionId, original.externalResourceId), [original.id]],
      [resourceLookupKey(secondConnection.id, original.externalResourceId), [secondResource.id]],
    ]);
    expect(resolveExactResourceLink({
      cloudConnectionId: secondConnection.id,
      externalResourceId: original.externalResourceId,
      resourceIdsByKey: links,
    })).toEqual({ cloudResourceId: secondResource.id });

    const sampledAt = new Date('2026-08-03T01:00:00.000Z');
    await prisma.resourceMetricSample.createMany({
      data: [original, secondResource].map((resource, index) => ({
        tenantId,
        cloudConnectionId: resource.cloudConnectionId,
        cloudResourceId: resource.id,
        provider: 'AWS' as const,
        externalResourceId: resource.externalResourceId,
        metricName: 'CursorCanary',
        metricUnit: '%',
        value: new Prisma.Decimal(index + 1),
        sampledAt,
        granularitySeconds: 1800,
        sourceType: 'TECHNICAL_METRIC' as const,
      })),
    });
    const seriesRepository = new PrismaResourceMetricRepository(prisma);
    const seriesFilters = {
      startDate: new Date('2026-08-03T00:00:00.000Z'),
      endDate: new Date('2026-08-03T02:00:00.000Z'),
      externalResourceId: original.externalResourceId,
      metricNames: ['CursorCanary'],
      bucket: 'raw' as const,
      pageSize: 1,
    };
    const firstPage = await seriesRepository.listMetricSeriesForTenant(tenantId, seriesFilters);
    const secondPage = await seriesRepository.listMetricSeriesForTenant(tenantId, {
      ...seriesFilters,
      cursor: firstPage.nextCursor,
    });
    expect(firstPage.totalSamples).toBe(2);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.points).toHaveLength(1);
    expect(new Set([firstPage.points[0]?.cloudResourceId, secondPage.points[0]?.cloudResourceId]).size).toBe(2);
  }, 120_000);

  it('rejects cross-tenant resource references at the database boundary', async () => {
    const tenantAResource = await prisma.cloudResource.findFirstOrThrow({ where: { tenantId: fixtures.tenants[0]!.id } });
    const tenantBResource = await prisma.cloudResource.findFirstOrThrow({ where: { tenantId: fixtures.tenants[1]!.id } });
    const cost = await prisma.costMetric.findFirstOrThrow({ where: { tenantId: fixtures.tenants[0]!.id } });
    await expect(prisma.$executeRaw`
      UPDATE cost_metrics
      SET cloud_resource_id = ${tenantBResource.id}
      WHERE tenant_id = ${fixtures.tenants[0]!.id}
        AND charge_period_start = ${cost.chargePeriodStart}
        AND metric_identity_hash = ${cost.metricIdentityHash}
    `).rejects.toThrow();
    expect(tenantAResource.tenantId).not.toBe(tenantBResource.tenantId);
  }, 120_000);

  it('keeps readiness aggregation bounded on representative data volumes', async () => {
    const tenantId = fixtures.tenants[0]!.id;
    const resource = await prisma.cloudResource.findFirstOrThrow({ where: { tenantId } });
    const account = await prisma.cloudAccount.findFirstOrThrow({ where: { tenantId } });
    const now = new Date();
    const costRows = Array.from({ length: 10_000 }, (_, index) => ({
      tenantId,
      cloudAccountId: account.id,
      cloudConnectionId: resource.cloudConnectionId,
      cloudResourceId: resource.id,
      provider: 'AWS' as const,
      serviceName: resource.serviceName,
      resourceId: resource.externalResourceId,
      chargePeriodStart: new Date(now.getTime() - index * 60_000),
      chargePeriodEnd: now,
      billedCost: new Prisma.Decimal('1.00'),
      billingCurrency: 'USD',
      sourceMetric: 'RESOURCE_LINKAGE_PERF',
      metricIdentityHash: `${fixtures.runId}:perf-cost:${index}`,
    }));
    for (let index = 0; index < costRows.length; index += 500) {
      await prisma.costMetric.createMany({ data: costRows.slice(index, index + 500) });
    }

    const metricRows = Array.from({ length: 20_000 }, (_, index) => ({
      tenantId,
      cloudConnectionId: resource.cloudConnectionId,
      cloudResourceId: resource.id,
      provider: 'AWS' as const,
      externalResourceId: resource.externalResourceId,
      metricName: 'PerfMetric',
      metricUnit: '%',
      value: new Prisma.Decimal(index % 100),
      sampledAt: new Date(now.getTime() - index * 1_000),
      granularitySeconds: 60,
      sourceType: 'TECHNICAL_METRIC' as const,
    }));
    for (let index = 0; index < metricRows.length; index += 1_000) {
      await prisma.resourceMetricSample.createMany({ data: metricRows.slice(index, index + 1_000) });
    }

    const repository = new PrismaResourceLinkageReadinessRepository(prisma);
    const timings: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const startedAt = performance.now();
      await repository.getForTenant(tenantId, 10);
      timings.push(performance.now() - startedAt);
    }
    timings.sort((left, right) => left - right);
    const medianMs = timings[Math.floor(timings.length / 2)]!;
    console.warn(`[resource-linkage-perf] median=${medianMs.toFixed(2)}ms samples=${timings.map((value) => value.toFixed(2)).join(',')}`);
    expect(Number.isFinite(medianMs)).toBe(true);
    expect(medianMs).toBeLessThan(5_000);
  }, 180_000);

  it('classifies weak or stale evidence before technical generation', () => {
    const stale = buildResourceFreshness({
      inventoryAt: new Date('2020-01-01T00:00:00.000Z'),
      costsAt: new Date('2020-01-01T00:00:00.000Z'),
      metricsAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(classifyResourceEvidenceStatus({ costCount: 10, metricCount: 10, freshness: stale })).toBe('STALE_DATA');
  });
});

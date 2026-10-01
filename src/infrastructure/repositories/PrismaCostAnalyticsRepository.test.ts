import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaCostAnalyticsRepository } from './PrismaCostAnalyticsRepository.js';
import { runSnapshotAggregations } from './queries/costAnalyticsSnapshotQueries.js';

describe('PrismaCostAnalyticsRepository', () => {
  it('falls back to the tenant-scoped inventory name for top cost resources', async () => {
    const statements: string[] = [];
    const queryRaw = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      statements.push(Array.from(strings).join('?'));
      return Promise.resolve([]);
    });
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;

    await runSnapshotAggregations(
      prisma,
      'tenant-1',
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-10-01T00:00:00.000Z'),
    );

    const topResourcesQuery = statements.find((statement) => statement.includes('left join cloud_resources cr'));
    expect(topResourcesQuery).toContain("coalesce(max(nullif(cm.resource_name, '')), max(cr.name)) as resource_name");
    expect(topResourcesQuery).toContain('cr.tenant_id = cm.tenant_id');
  });

  it('applies the requested forecast month range', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { costForecast: { findMany } } as unknown as PrismaClient;
    const repository = new PrismaCostAnalyticsRepository(prisma);
    const from = new Date('2026-07-01T00:00:00.000Z');
    const to = new Date('2026-09-01T00:00:00.000Z');

    await repository.findForecasts('tenant-1', {
      from,
      to,
      provider: 'OCI',
      cloudAccountId: 'account-1',
      serviceName: 'Compute',
      groupBy: 'service',
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        forecastMonth: { gte: from, lt: to },
        provider: 'OCI',
        cloudAccountId: 'account-1',
        serviceName: 'Compute',
        groupBy: 'service',
      },
      orderBy: [
        { forecastMonth: 'asc' },
        { predictedCost: 'desc' },
      ],
      take: 100,
    });
  });

  it.each([
    ['newer billing coverage', new Date('2026-09-23T00:00:00.000Z'), true],
    ['the daily period boundary grace', new Date('2026-08-29T00:00:00.000Z'), false],
  ])('checks opportunity freshness against %s', async (_label, latestPeriodEnd, isStale) => {
    const detectedAt = new Date('2026-08-28T18:44:05.689Z');
    const findMany = vi.fn().mockResolvedValue([{
      id: 'opp-1', tenantId: 'tenant-1', cloudAccountId: null, provider: null,
      serviceName: 'COMPUTE', resourceId: null, environment: null,
      periodStart: new Date('2026-08-01T00:00:00.000Z'), periodEnd: new Date('2026-09-01T00:00:00.000Z'),
      baselineCost: 10, observedCost: 20, deltaAmount: 10, deltaPercent: 100, zScore: null,
      severity: 'HIGH', status: 'OPEN', explanation: 'test', evidence: {}, detectedAt,
    }]);
    const aggregate = vi.fn().mockResolvedValue({ _max: { chargePeriodEnd: latestPeriodEnd } });
    const prisma = { costAnomaly: { findMany }, costMetric: { aggregate } } as unknown as PrismaClient;

    const result = await new PrismaCostAnalyticsRepository(prisma).findAnomalies('tenant-1');

    expect(result[0]?.isStale).toBe(isStale ? true : undefined);
    expect(aggregate).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' }, _max: { chargePeriodEnd: true } });
  });
});

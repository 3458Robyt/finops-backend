import { describe, expect, test } from 'vitest';
import { PrismaResourceMetricRepository } from '../infrastructure/repositories/PrismaResourceMetricRepository.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
} from './e2eFixtures.js';

describe('technical metrics PostgreSQL integration', () => {
  test('preserves raw values, bucket statistics, pagination and tenant isolation', async () => {
    if (process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true') {
      return;
    }

    const prisma = createTestingPrismaClient();
    const runId = `metrics-${Date.now()}`;
    try {
      const fixtures = await createE2eFixtures(prisma, runId);
      const repository = new PrismaResourceMetricRepository(prisma);
      const tenantA = fixtures.tenants[0];
      const tenantB = fixtures.tenants[1];
      expect(tenantA).toBeDefined();
      expect(tenantB).toBeDefined();
      const fixturePeriod = await prisma.costMetric.findFirstOrThrow({
        where: { tenantId: tenantA!.id },
        orderBy: { chargePeriodStart: 'asc' },
        select: { chargePeriodStart: true },
      });
      const fixtureResource = await prisma.cloudResource.findUniqueOrThrow({
        where: { id: fixtures.resourceIds[0] },
        select: { externalResourceId: true },
      });

      const filters = {
        startDate: fixturePeriod.chargePeriodStart,
        endDate: addUtcDays(fixturePeriod.chargePeriodStart, 2),
        metricNames: ['CPUUtilization'],
        pageSize: 10,
      } as const;
      const raw = await repository.listMetricSeriesForTenant(tenantA!.id, { ...filters, bucket: 'raw' });
      expect(raw.points).toHaveLength(10);
      expect(raw.points.every((point) => point.avg === point.min && point.avg === point.max)).toBe(true);
      expect(raw.points.every((point) => point.externalResourceId === fixtureResource.externalResourceId)).toBe(true);
      expect(raw.hasMore).toBe(true);
      expect(raw.nextCursor).toBeDefined();

      const next = await repository.listMetricSeriesForTenant(tenantA!.id, {
        ...filters,
        bucket: 'raw',
        cursor: raw.nextCursor,
      });
      expect(next.points[0]?.bucketStart.getTime()).toBeGreaterThan(raw.points.at(-1)?.bucketStart.getTime() ?? 0);

      const hourly = await repository.listMetricSeriesForTenant(tenantA!.id, { ...filters, bucket: 'hour' });
      expect(hourly.points.length).toBeGreaterThan(0);
      expect(hourly.points.every((point) => point.min <= point.avg && point.avg <= point.max)).toBe(true);
      expect(hourly.points.every((point) => point.sampleCount > 0)).toBe(true);

      const otherTenant = await repository.listMetricSeriesForTenant(tenantB!.id, { ...filters, bucket: 'raw' });
      expect(otherTenant.points).toHaveLength(10);
      expect(otherTenant.points.every((point) => point.externalResourceId !== fixtureResource.externalResourceId)).toBe(true);
    } finally {
      await cleanupE2eFixtures(prisma, runId);
      await prisma.$disconnect();
    }
  }, 30_000);
});

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

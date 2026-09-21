import { describe, expect, test } from 'vitest';
import { PrismaResourceMetricRepository } from '../infrastructure/repositories/PrismaResourceMetricRepository.js';
import {
  cleanupE2eFixtures,
  createE2eFixtures,
  createTestingPrismaClient,
} from './e2eFixtures.js';

describe('technical metrics PostgreSQL integration', () => {
  test.skipIf(process.env['RUN_DB_INTEGRATION_TESTS'] !== 'true')('preserves raw values, bucket statistics, pagination and tenant isolation', async () => {
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

      const halfHourly = await repository.listMetricSeriesForTenant(tenantA!.id, { ...filters, bucket: '30m', pageSize: 2 });
      expect(halfHourly.points).toHaveLength(2);
      expect(halfHourly.points.every((point) => point.min <= point.avg && point.avg <= point.max)).toBe(true);
      expect(halfHourly.points.every((point) => point.sampleCount > 0)).toBe(true);
      expect(halfHourly.hasMore).toBe(true);
      const nextHalfHourly = await repository.listMetricSeriesForTenant(tenantA!.id, {
        ...filters,
        bucket: '30m',
        pageSize: 2,
        cursor: halfHourly.nextCursor,
      });
      expect(nextHalfHourly.points[0]?.bucketStart.getTime()).toBeGreaterThan(halfHourly.points.at(-1)?.bucketStart.getTime() ?? 0);

      const firstSample = await prisma.resourceMetricSample.findFirstOrThrow({
        where: { tenantId: tenantA!.id, metricName: 'CPUUtilization', statistic: 'MEAN' },
        orderBy: { sampledAt: 'asc' },
      });
      // OCI/AWS counters such as bytes and requests can exceed DECIMAL(24,9).
      // Keep this regression in the real PostgreSQL suite so a migration that
      // narrows either raw or rollup precision fails before production.
      await prisma.$executeRaw`
        UPDATE resource_metric_samples
        SET value = 9000000000000000.123456789
        WHERE id = ${firstSample.id}
      `;
      await prisma.$executeRaw`
        INSERT INTO resource_metric_rollups (
          id, tenant_id, cloud_connection_id, cloud_resource_id, provider,
          external_resource_id, provider_namespace, region_id, compartment_id,
          dimensions_hash, metric_name, metric_unit, statistic, bucket_seconds,
          bucket_start, sample_count, sum_value, avg_value, min_value,
          p50_value, p90_value, p95_value, p99_value, min_sampled_at,
          max_value, max_sampled_at, latest_value, latest_sampled_at,
          source_granularities, updated_at
        )
        SELECT md5(concat_ws('|', s.cloud_connection_id, s.provider_namespace, s.region_id,
          s.external_resource_id, s.metric_name, s.statistic::text, '3600',
          date_trunc('hour', s.sampled_at)::text, s.dimensions_hash)),
          s.tenant_id, s.cloud_connection_id, s.cloud_resource_id, s.provider,
          s.external_resource_id, s.provider_namespace, s.region_id, s.compartment_id,
          s.dimensions_hash, s.metric_name, s.metric_unit, s.statistic, 3600,
          date_trunc('hour', s.sampled_at), 1, s.value, s.value, s.value,
          NULL, NULL, NULL, NULL, s.sampled_at, s.value, s.sampled_at,
          s.value, s.sampled_at, ARRAY[1800]::int[], CURRENT_TIMESTAMP
        FROM resource_metric_samples s
        WHERE s.id = ${firstSample.id}
      `;

      const expectedRawSamples = await prisma.resourceMetricSample.count({
        where: {
          tenantId: tenantA!.id,
          metricName: 'CPUUtilization',
          statistic: 'MEAN',
          sampledAt: { gte: fixturePeriod.chargePeriodStart, lt: addUtcDays(fixturePeriod.chargePeriodStart, 1) },
        },
      });
      const staleRollupFallback = await repository.listMetricSeriesForTenant(tenantA!.id, {
        ...filters,
        endDate: new Date(addUtcDays(fixturePeriod.chargePeriodStart, 1).getTime() - 1),
        bucket: 'hour',
      });
      expect(staleRollupFallback.totalSamples).toBe(expectedRawSamples);
      expect(staleRollupFallback.points[0]?.sampleCount).toBe(2);

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

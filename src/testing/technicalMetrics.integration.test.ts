import { describe, expect, test } from 'vitest';
import { PrismaResourceMetricRepository } from '../infrastructure/repositories/PrismaResourceMetricRepository.js';
import { PrismaResourceMetricRollupPersistence } from '../infrastructure/repositories/PrismaResourceMetricRollupPersistence.js';
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
      await new PrismaResourceMetricRollupPersistence().refreshAll(prisma, tenantA!.id);
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

      const nativeHalfHourlySample = await prisma.resourceMetricSample.findFirstOrThrow({
        where: {
          tenantId: tenantA!.id,
          metricName: 'CPUUtilization',
          statistic: 'MEAN',
          granularitySeconds: 1800,
        },
      });
      const boundaryJob = await prisma.ingestionJob.findFirstOrThrow({
        where: { tenantId: tenantA!.id, sourceType: 'TECHNICAL_METRIC', status: 'PENDING' },
        select: { id: true, targetEnd: true },
      });
      const nativeHourlySampleAt = nativeHalfHourlySample.sampledAt;
      await prisma.ingestionJob.update({
        where: { id: boundaryJob.id },
        data: { targetStart: nativeHourlySampleAt, targetEnd: nativeHourlySampleAt },
      });
      await prisma.resourceMetricSample.create({
        data: {
          tenantId: tenantA!.id,
          cloudConnectionId: nativeHalfHourlySample.cloudConnectionId,
          cloudResourceId: nativeHalfHourlySample.cloudResourceId,
          provider: nativeHalfHourlySample.provider,
          externalResourceId: nativeHalfHourlySample.externalResourceId,
          metricName: nativeHalfHourlySample.metricName,
          metricUnit: nativeHalfHourlySample.metricUnit,
          value: 77,
          sampledAt: nativeHourlySampleAt,
          granularitySeconds: 3600,
          sourceType: 'TECHNICAL_METRIC',
          ingestionJobId: boundaryJob.id,
          rawMetric: { fixture: true, nativeGranularity: 3600 },
        },
      });
      await new PrismaResourceMetricRollupPersistence().refreshForJob(prisma, boundaryJob.id);
      const mixedNativeResolution = await repository.listMetricSeriesForTenant(tenantA!.id, {
        ...filters,
        externalResourceId: nativeHalfHourlySample.externalResourceId,
        startDate: startOfUtcHour(nativeHourlySampleAt),
        endDate: endOfUtcHour(nativeHourlySampleAt),
        pageSize: 1000,
        bucket: '30m',
      });
      const expectedMixedRawCount = await prisma.resourceMetricSample.count({
        where: {
          tenantId: tenantA!.id,
          externalResourceId: nativeHalfHourlySample.externalResourceId,
          metricName: 'CPUUtilization',
          statistic: 'MEAN',
          sampledAt: {
            gte: startOfUtcHour(nativeHourlySampleAt),
            lte: endOfUtcHour(nativeHourlySampleAt),
          },
        },
      });
      expect(mixedNativeResolution.totalSamples).toBe(expectedMixedRawCount);
      expect(mixedNativeResolution.points.some((point) => point.sourceGranularitiesSeconds.includes(1800))).toBe(true);
      expect(mixedNativeResolution.points.some((point) => point.sourceGranularitiesSeconds.includes(3600))).toBe(true);

      const expectedHourlyValue = await prisma.$queryRaw<readonly [{ readonly value: number; readonly samples: number }][]>`
        SELECT AVG(value)::float8 AS value, COUNT(*)::int AS samples
        FROM resource_metric_samples
        WHERE tenant_id = ${tenantA!.id}
          AND external_resource_id = ${nativeHalfHourlySample.externalResourceId}
          AND cloud_connection_id = ${nativeHalfHourlySample.cloudConnectionId}
          AND provider_namespace IS NOT DISTINCT FROM ${nativeHalfHourlySample.providerNamespace}
          AND region_id IS NOT DISTINCT FROM ${nativeHalfHourlySample.regionId}
          AND dimensions_hash IS NOT DISTINCT FROM ${nativeHalfHourlySample.dimensionsHash}
          AND metric_name = 'CPUUtilization'
          AND statistic = 'MEAN'::"MetricStatistic"
          AND sampled_at >= ${startOfUtcHour(nativeHourlySampleAt)}
          AND sampled_at <= ${endOfUtcHour(nativeHourlySampleAt)}
      `;
      const hourlyNativeResolution = await repository.listMetricSeriesForTenant(tenantA!.id, {
        ...filters,
        externalResourceId: nativeHalfHourlySample.externalResourceId,
        startDate: startOfUtcHour(nativeHourlySampleAt),
        endDate: endOfUtcHour(nativeHourlySampleAt),
        pageSize: 1000,
        bucket: 'hour',
      });
      const hourlyPoint = hourlyNativeResolution.points.find((point) =>
        (point.providerNamespace ?? '') === (nativeHalfHourlySample.providerNamespace ?? '')
          && (point.regionId ?? '') === (nativeHalfHourlySample.regionId ?? '')
          && (point.dimensionsHash ?? '') === (nativeHalfHourlySample.dimensionsHash ?? ''));
      expect(hourlyNativeResolution.totalSamples).toBe(expectedMixedRawCount);
      expect(hourlyPoint?.sourceGranularitiesSeconds).toEqual([1800, 3600]);
      expect(hourlyPoint?.sampleCount).toBe(expectedHourlyValue[0]?.samples);
      expect(hourlyPoint?.value).toBe(Math.round((expectedHourlyValue[0]?.value ?? 0) * 1000) / 1000);
      expect(hourlyPoint?.aggregationSemantics).toBe('POSTGRES_ROLLUP_DERIVED_PEAK_AWARE');

      const dailyNativeResolution = await repository.listMetricSeriesForTenant(tenantA!.id, {
        ...filters,
        externalResourceId: nativeHalfHourlySample.externalResourceId,
        startDate: startOfUtcDay(nativeHourlySampleAt),
        endDate: endOfUtcDay(nativeHourlySampleAt),
        pageSize: 1000,
        bucket: 'day',
      });
      const expectedDailyRawCount = await prisma.resourceMetricSample.count({
        where: {
          tenantId: tenantA!.id,
          externalResourceId: nativeHalfHourlySample.externalResourceId,
          metricName: 'CPUUtilization',
          statistic: 'MEAN',
          sampledAt: {
            gte: startOfUtcDay(nativeHourlySampleAt),
            lte: endOfUtcDay(nativeHourlySampleAt),
          },
        },
      });
      expect(dailyNativeResolution.totalSamples).toBe(expectedDailyRawCount);
      const dailyPoint = dailyNativeResolution.points.find((point) =>
        (point.providerNamespace ?? '') === (nativeHalfHourlySample.providerNamespace ?? '')
          && (point.regionId ?? '') === (nativeHalfHourlySample.regionId ?? '')
          && (point.dimensionsHash ?? '') === (nativeHalfHourlySample.dimensionsHash ?? ''));
      const expectedDailyStreamCount = await prisma.resourceMetricSample.count({
        where: {
          tenantId: tenantA!.id,
          cloudConnectionId: nativeHalfHourlySample.cloudConnectionId,
          externalResourceId: nativeHalfHourlySample.externalResourceId,
          providerNamespace: nativeHalfHourlySample.providerNamespace,
          regionId: nativeHalfHourlySample.regionId,
          dimensionsHash: nativeHalfHourlySample.dimensionsHash,
          metricName: 'CPUUtilization',
          statistic: 'MEAN',
          sampledAt: {
            gte: startOfUtcDay(nativeHourlySampleAt),
            lte: endOfUtcDay(nativeHourlySampleAt),
          },
        },
      });
      expect(dailyPoint?.sampleCount).toBe(expectedDailyStreamCount);
      expect(dailyPoint?.sourceGranularitiesSeconds).toEqual([86400]);
      expect(dailyPoint?.aggregationSemantics).toBe('POSTGRES_ROLLUP_DERIVED_PEAK_AWARE');

      const staleRollupCandidate = await prisma.$queryRaw<readonly [{ readonly id: string }]>`
        SELECT sample.id
        FROM resource_metric_samples sample
        WHERE sample.tenant_id = ${tenantA!.id}
          AND sample.metric_name = 'CPUUtilization'
          AND sample.statistic = 'MEAN'::"MetricStatistic"
          AND sample.granularity_seconds = 1800
          AND to_timestamp(floor(extract(epoch FROM sample.sampled_at) / 3600) * 3600)
            <> to_timestamp(floor(extract(epoch FROM CAST(${nativeHourlySampleAt} AS timestamptz)) / 3600) * 3600)
          AND NOT EXISTS (
            SELECT 1
            FROM resource_metric_rollups rollup
            WHERE rollup.tenant_id = sample.tenant_id
              AND rollup.cloud_connection_id = sample.cloud_connection_id
              AND rollup.external_resource_id = sample.external_resource_id
              AND rollup.provider_namespace = sample.provider_namespace
              AND rollup.region_id = sample.region_id
              AND rollup.dimensions_hash = sample.dimensions_hash
              AND rollup.metric_name = sample.metric_name
              AND rollup.statistic = sample.statistic
              AND rollup.bucket_seconds = 3600
              AND rollup.bucket_start = to_timestamp(floor(extract(epoch FROM sample.sampled_at) / 3600) * 3600)
          )
        ORDER BY sample.sampled_at ASC
        LIMIT 1
      `;
      expect(staleRollupCandidate[0]).toBeDefined();
      const firstSample = await prisma.resourceMetricSample.findUniqueOrThrow({
        where: { id: staleRollupCandidate[0]!.id },
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

      const staleBucketStart = startOfUtcHour(firstSample.sampledAt);
      const staleBucketEnd = endOfUtcHour(firstSample.sampledAt);
      const expectedRawSamples = await prisma.resourceMetricSample.count({
        where: {
          tenantId: tenantA!.id,
          cloudConnectionId: firstSample.cloudConnectionId,
          externalResourceId: firstSample.externalResourceId,
          providerNamespace: firstSample.providerNamespace,
          regionId: firstSample.regionId,
          dimensionsHash: firstSample.dimensionsHash,
          metricName: 'CPUUtilization',
          statistic: 'MEAN',
          sampledAt: { gte: staleBucketStart, lte: staleBucketEnd },
        },
      });
      const staleRollupFallback = await repository.listMetricSeriesForTenant(tenantA!.id, {
        ...filters,
        externalResourceId: firstSample.externalResourceId,
        startDate: staleBucketStart,
        endDate: staleBucketEnd,
        bucket: 'hour',
      });
      expect(staleRollupFallback.totalSamples).toBe(expectedRawSamples);
      const exactFallbackPoint = staleRollupFallback.points.find((point) =>
        (point.providerNamespace ?? '') === (firstSample.providerNamespace ?? '')
          && (point.regionId ?? '') === (firstSample.regionId ?? '')
          && (point.dimensionsHash ?? '') === (firstSample.dimensionsHash ?? ''));
      expect(exactFallbackPoint?.sampleCount).toBe(expectedRawSamples);
      expect(exactFallbackPoint?.aggregationSemantics).toBe('MEAN_OF_NATIVE');

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

function startOfUtcHour(value: Date): Date {
  const result = new Date(value);
  result.setUTCMinutes(0, 0, 0);
  return result;
}

function endOfUtcHour(value: Date): Date {
  return new Date(startOfUtcHour(value).getTime() + 60 * 60 * 1000 - 1);
}

function startOfUtcDay(value: Date): Date {
  const result = new Date(value);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

function endOfUtcDay(value: Date): Date {
  return new Date(startOfUtcDay(value).getTime() + 24 * 60 * 60 * 1000 - 1);
}

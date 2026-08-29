import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaResourceMetricCoverageReader } from './PrismaResourceMetricCoverageReader.js';

describe('PrismaResourceMetricCoverageReader', () => {
  it('obtains summary, metric and day coverage with one filtered query', async () => {
    let queryCalls = 0;
    const prisma = {
      $queryRaw: async () => {
        queryCalls += 1;
        return [{
          total_samples: 96n,
          metric_count: 2n,
          resource_count: 1n,
          min_sampled_at: new Date('2026-08-20T00:00:00.000Z'),
          max_sampled_at: new Date('2026-08-21T23:30:00.000Z'),
          metrics: [{
            metricName: 'CpuUtilization',
            sampleCount: 48n,
            daysWithData: 2n,
            minSampledAt: '2026-08-20T00:00:00.000Z',
            maxSampledAt: '2026-08-21T23:30:00.000Z',
          }],
          days: [{ date: '2026-08-20', sampleCount: 48n, metricCount: 2n }],
        }];
      },
    } as unknown as PrismaClient;

    const result = await new PrismaResourceMetricCoverageReader(prisma).getForTenant('tenant-1', {
      startDate: new Date('2026-08-20T00:00:00.000Z'),
      endDate: new Date('2026-08-22T00:00:00.000Z'),
    });

    expect(queryCalls).toBe(1);
    expect(result).toEqual({
      totalSamples: 96,
      metricCount: 2,
      resourceCount: 1,
      minSampledAt: new Date('2026-08-20T00:00:00.000Z'),
      maxSampledAt: new Date('2026-08-21T23:30:00.000Z'),
      metrics: [{
        metricName: 'CpuUtilization',
        sampleCount: 48,
        daysWithData: 2,
        minSampledAt: new Date('2026-08-20T00:00:00.000Z'),
        maxSampledAt: new Date('2026-08-21T23:30:00.000Z'),
      }],
      days: [{ date: '2026-08-20', sampleCount: 48, metricCount: 2 }],
    });
  });
});

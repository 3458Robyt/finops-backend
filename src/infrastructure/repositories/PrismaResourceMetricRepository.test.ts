import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaResourceMetricRepository } from './PrismaResourceMetricRepository.js';

describe('PrismaResourceMetricRepository', () => {
  it('uses the bounded stream summary catalog before scanning raw samples', async () => {
    let queryCalls = 0;
    const prisma = {
      $queryRaw: async () => {
        queryCalls += 1;
        return [{ metric_name: 'CpuUtilization', statistic: 'MEAN' }];
      },
    } as unknown as PrismaClient;

    const result = await new PrismaResourceMetricRepository(prisma).listMetricStatisticsForTenant('tenant-1', {});

    expect(queryCalls).toBe(1);
    expect(result).toEqual([{ metricName: 'CpuUtilization', statistic: 'MEAN' }]);
  });

  it('keeps the raw catalog fallback for tenants without a summary projection', async () => {
    let queryCalls = 0;
    const prisma = {
      $queryRaw: async () => {
        queryCalls += 1;
        return queryCalls === 1
          ? []
          : [{ metric_name: 'MemoryUtilization', statistic: 'P95' }];
      },
    } as unknown as PrismaClient;

    const result = await new PrismaResourceMetricRepository(prisma).listMetricStatisticsForTenant('tenant-1', {});

    expect(queryCalls).toBe(2);
    expect(result).toEqual([{ metricName: 'MemoryUtilization', statistic: 'P95' }]);
  });
});

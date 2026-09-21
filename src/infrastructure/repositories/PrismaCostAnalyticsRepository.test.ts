import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaCostAnalyticsRepository } from './PrismaCostAnalyticsRepository.js';

describe('PrismaCostAnalyticsRepository', () => {
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
});

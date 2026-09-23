import type { AnalyticsFilters } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

export async function queryCostAnomalies(
  prisma: PrismaClient,
  tenantId: string,
  filters: AnalyticsFilters,
) {
  const [rows, latestCost] = await Promise.all([
    prisma.costAnomaly.findMany({
      where: {
        tenantId,
        ...(filters.from !== undefined ? { periodStart: { gte: filters.from } } : {}),
        ...(filters.to !== undefined ? { periodStart: { lt: filters.to } } : {}),
        ...(filters.provider !== undefined ? { provider: filters.provider as never } : {}),
        ...(filters.cloudAccountId !== undefined ? { cloudAccountId: filters.cloudAccountId } : {}),
        ...(filters.serviceName !== undefined ? { serviceName: filters.serviceName } : {}),
      },
      orderBy: [{ severity: 'desc' }, { detectedAt: 'desc' }],
      take: 100,
    }),
    // Uses cost_metrics_tenant_period_end_idx; avoid scanning created_at on the large ledger.
    prisma.costMetric.aggregate({ where: { tenantId }, _max: { chargePeriodEnd: true } }),
  ]);

  return { rows, latestCostPeriodEnd: latestCost._max.chargePeriodEnd };
}

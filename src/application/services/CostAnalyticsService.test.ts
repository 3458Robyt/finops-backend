import { describe, expect, it } from 'vitest';
import type {
  AnalyticsFilters,
  CostAnomaly,
  CostAnalyticsSnapshot,
  CostForecast,
  ICostAnalyticsRepository,
  MonthlyCostPoint,
  MonthlyUsagePoint,
  PersistCostAnomalyInput,
  PersistCostForecastInput,
} from '../../domain/interfaces/ICostAnalyticsRepository.js';
import { CostAnalyticsService } from './CostAnalyticsService.js';

class ConcurrentGuardAnalyticsRepository implements ICostAnalyticsRepository {
  public maxConcurrentForecastReplacements = 0;
  private activeForecastReplacements = 0;

  public async getLatestTenantSnapshot(tenantId: string): Promise<CostAnalyticsSnapshot> {
    return {
      accounts: [],
      currency: 'USD',
      environments: [],
      forecasts: [],
      metricCount: 0,
      periodEnd: '2026-05-01T00:00:00.000Z',
      periodStart: '2026-02-01T00:00:00.000Z',
      providers: [],
      services: [],
      tenantId,
      topResources: [],
      totalCost: 0,
    };
  }

  public async getMonthlyCostSeries(
    _tenantId: string,
    _filters?: AnalyticsFilters,
  ): Promise<MonthlyCostPoint[]> {
    return [
      this.point('2026-02-01T00:00:00.000Z', 10),
      this.point('2026-03-01T00:00:00.000Z', 12),
      this.point('2026-04-01T00:00:00.000Z', 14),
    ];
  }

  public async getMonthlyUsageSeries(
    _tenantId: string,
    _filters?: AnalyticsFilters,
  ): Promise<MonthlyUsagePoint[]> {
    return [
      this.usagePoint('2026-02-01T00:00:00.000Z', 100, 10),
      this.usagePoint('2026-03-01T00:00:00.000Z', 120, 12),
      this.usagePoint('2026-04-01T00:00:00.000Z', 180, 18),
    ];
  }

  public async findAnomalies(): Promise<CostAnomaly[]> {
    return [];
  }

  public async replaceAnomalies(
    _tenantId: string,
    _anomalies: readonly PersistCostAnomalyInput[],
  ): Promise<CostAnomaly[]> {
    return [];
  }

  public async findForecasts(): Promise<CostForecast[]> {
    return [];
  }

  public async replaceForecasts(
    _tenantId: string,
    forecasts: readonly PersistCostForecastInput[],
  ): Promise<CostForecast[]> {
    this.activeForecastReplacements += 1;
    this.maxConcurrentForecastReplacements = Math.max(
      this.maxConcurrentForecastReplacements,
      this.activeForecastReplacements,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    this.activeForecastReplacements -= 1;

    return forecasts.map((forecast, index) => ({
      confidence: forecast.confidence,
      currency: forecast.currency,
      forecastMonth: forecast.forecastMonth.toISOString(),
      generatedAt: '2026-05-01T00:00:00.000Z',
      groupBy: forecast.groupBy,
      groupKey: forecast.groupKey,
      id: `forecast-${index}`,
      lowerBound: forecast.lowerBound,
      method: forecast.method,
      predictedCost: forecast.predictedCost,
      tenantId: forecast.tenantId,
      upperBound: forecast.upperBound,
      ...(forecast.cloudAccountId !== undefined ? { cloudAccountId: forecast.cloudAccountId } : {}),
      ...(forecast.provider !== undefined ? { provider: forecast.provider } : {}),
      ...(forecast.serviceName !== undefined ? { serviceName: forecast.serviceName } : {}),
      ...(forecast.evidence !== undefined ? { evidence: forecast.evidence } : {}),
    }));
  }

  private point(month: string, cost: number): MonthlyCostPoint {
    return {
      cost,
      currency: 'USD',
      groupBy: 'service',
      groupKey: 'COMPUTE',
      metricCount: 1,
      month,
      provider: 'OCI',
      serviceName: 'COMPUTE',
    };
  }

  private usagePoint(month: string, consumedQuantity: number, cost: number): MonthlyUsagePoint {
    return {
      consumedQuantity,
      consumedUnit: 'OCPU hour',
      cost,
      currency: 'USD',
      groupBy: 'service',
      groupKey: 'COMPUTE (OCPU hour)',
      metricCount: 1,
      month,
      provider: 'OCI',
      serviceName: 'COMPUTE',
      unitCost: cost / consumedQuantity,
    };
  }
}

describe('CostAnalyticsService', () => {
  it('serializes concurrent recomputes for the same tenant', async () => {
    const repository = new ConcurrentGuardAnalyticsRepository();
    const service = new CostAnalyticsService(repository);

    const results = await Promise.all([
      service.recompute({ tenantId: 'tenant-oci' }),
      service.recompute({ tenantId: 'tenant-oci' }),
      service.recompute({ tenantId: 'tenant-oci' }),
    ]);

    expect(results.every((result) => result.forecasts.length === 3)).toBe(true);
    expect(results.every((result) => result.usageInsights.length > 0)).toBe(true);
    expect(repository.maxConcurrentForecastReplacements).toBe(1);
  });
});

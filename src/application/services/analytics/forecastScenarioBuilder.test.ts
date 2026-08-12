import { describe, expect, it } from 'vitest';
import type { CostForecast } from '../../../domain/interfaces/costAnalytics/costAnalyticsModels.js';
import { buildForecastScenarios } from './forecastScenarioBuilder.js';

describe('buildForecastScenarios', () => {
  it('separa tendencia, aprobado, ejecutado y verificado sin producir costos negativos', () => {
    const forecasts: CostForecast[] = [
      forecast('f-1', '2026-09-01T00:00:00.000Z', 100, 80),
      forecast('f-2', '2026-09-01T00:00:00.000Z', 50, 40),
    ];

    const result = buildForecastScenarios(forecasts, {
      approved: new Map([['USD', 30]]),
      executed: new Map([['USD', 120]]),
      verified: new Map([['USD', 10]]),
      scope: 'TENANT',
    });

    expect(result).toHaveLength(5);
    expect(result.find((item) => item.scenario === 'BASELINE')).toMatchObject({ predictedCost: 120, savingsApplied: 0 });
    expect(result.find((item) => item.scenario === 'CURRENT_TREND')).toMatchObject({ predictedCost: 150, savingsApplied: 0 });
    expect(result.find((item) => item.scenario === 'APPROVED')).toMatchObject({ predictedCost: 120, savingsApplied: 30 });
    expect(result.find((item) => item.scenario === 'EXECUTED')).toMatchObject({ predictedCost: 30, savingsApplied: 120 });
    expect(result.find((item) => item.scenario === 'VERIFIED')).toMatchObject({ predictedCost: 140, savingsApplied: 10 });
  });

  it('usa el costo pronosticado como baseline cuando no existe evidencia del promedio', () => {
    const [scenario] = buildForecastScenarios([forecast('f-1', '2026-09-01T00:00:00.000Z', 90)], {
      approved: new Map(),
      executed: new Map(),
      verified: new Map(),
      scope: 'NOT_AVAILABLE',
    });

    expect(scenario?.evidence.baselineSource).toBe('PREDICTED_COST');
    expect(scenario?.evidence.savingsScope).toBe('NOT_AVAILABLE');
  });
});

function forecast(id: string, month: string, predictedCost: number, weightedAverage?: number): CostForecast {
  return {
    id,
    tenantId: 'tenant-1',
    groupBy: 'service',
    groupKey: id,
    forecastMonth: month,
    predictedCost,
    lowerBound: 0,
    upperBound: predictedCost * 2,
    method: 'test',
    confidence: 0.8,
    currency: 'USD',
    generatedAt: '2026-08-01T00:00:00.000Z',
    ...(weightedAverage === undefined ? {} : { evidence: { weightedAverage } }),
  };
}

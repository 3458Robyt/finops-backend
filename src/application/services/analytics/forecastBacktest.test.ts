import { describe, expect, it } from 'vitest';
import type { MonthlyCostPoint } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { evaluateForecastBacktest } from './forecastBacktest.js';

describe('evaluateForecastBacktest', () => {
  it('evalúa únicamente meses posteriores al entrenamiento y compara contra naive', () => {
    const result = evaluateForecastBacktest([
      point('2026-01-01', 100),
      point('2026-02-01', 110),
      point('2026-03-01', 120),
      point('2026-04-01', 130),
      point('2026-05-01', 140),
    ]);

    expect(result.trainingPoints).toBe(3);
    expect(result.evaluatedPoints).toBe(2);
    expect(result.mae).toBeGreaterThanOrEqual(0);
    expect(result.rmse).toBeGreaterThanOrEqual(result.mae);
    expect(result.wape).toBeDefined();
    expect(result.naiveWape).toBeDefined();
  });

  it('devuelve evidencia explícita cuando no hay suficientes meses', () => {
    expect(evaluateForecastBacktest([point('2026-01-01', 100), point('2026-02-01', 100)])).toEqual({
      trainingPoints: 3,
      evaluatedPoints: 0,
      mae: 0,
      rmse: 0,
    });
  });
});

function point(month: string, cost: number): MonthlyCostPoint {
  return {
    month,
    groupBy: 'service',
    groupKey: 'compute',
    cost,
    currency: 'USD',
    metricCount: 1,
  };
}

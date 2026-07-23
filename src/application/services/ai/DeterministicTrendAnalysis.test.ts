import { describe, expect, test } from 'vitest';

import { buildDeterministicTrendAnalysis } from './DeterministicTrendAnalysis.js';

describe('buildDeterministicTrendAnalysis', () => {
  test('agrega grupos por mes sin mezclar unidades y detecta divergencia', () => {
    const result = buildDeterministicTrendAnalysis(
      [
        { month: '2026-05', groupBy: 'service', groupKey: 'A', cost: 40, currency: 'USD', metricCount: 1 },
        { month: '2026-05', groupBy: 'service', groupKey: 'B', cost: 60, currency: 'USD', metricCount: 1 },
        { month: '2026-06', groupBy: 'service', groupKey: 'A', cost: 80, currency: 'USD', metricCount: 1 },
        { month: '2026-06', groupBy: 'service', groupKey: 'B', cost: 70, currency: 'USD', metricCount: 1 },
      ],
      [
        { month: '2026-05', groupBy: 'service', groupKey: 'A', consumedQuantity: 100, consumedUnit: 'Hours', cost: 50, currency: 'USD', metricCount: 1 },
        { month: '2026-06', groupBy: 'service', groupKey: 'A', consumedQuantity: 80, consumedUnit: 'Hours', cost: 75, currency: 'USD', metricCount: 1 },
        { month: '2026-05', groupBy: 'service', groupKey: 'B', consumedQuantity: 10, consumedUnit: 'GB-Mes', cost: 50, currency: 'USD', metricCount: 1 },
        { month: '2026-06', groupBy: 'service', groupKey: 'B', consumedQuantity: 10, consumedUnit: 'GB-Mes', cost: 75, currency: 'USD', metricCount: 1 },
      ],
    );

    expect(result.cost).toMatchObject({ previous: 100, current: 150, changePercent: 50, direction: 'UP' });
    expect(result.usageByUnit).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: 'Hours', trend: expect.objectContaining({ changePercent: -20 }) }),
    ]));
    expect(result.signals).toContain('COST_USAGE_TREND_DIVERGENCE');
  });

  test('declara historial insuficiente en vez de inferir una tendencia', () => {
    const result = buildDeterministicTrendAnalysis([], []);
    expect(result.cost).toBeNull();
    expect(result.signals).toEqual([
      'INSUFFICIENT_COST_TREND_HISTORY',
      'INSUFFICIENT_USAGE_TREND_HISTORY',
    ]);
  });
});

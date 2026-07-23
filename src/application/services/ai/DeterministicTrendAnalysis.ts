import type {
  MonthlyCostPoint,
  MonthlyUsagePoint,
} from '../../../domain/interfaces/ICostAnalyticsRepository.js';

export interface DeterministicTrend {
  readonly previous: number;
  readonly current: number;
  readonly changePercent: number;
  readonly direction: 'UP' | 'DOWN' | 'STABLE';
}

export interface DeterministicTrendAnalysis {
  readonly cost: DeterministicTrend | null;
  readonly usageByUnit: readonly {
    readonly unit: string;
    readonly trend: DeterministicTrend;
  }[];
  readonly costMonths: number;
  readonly usageMonths: number;
  readonly signals: readonly string[];
}

export function buildDeterministicTrendAnalysis(
  costPoints: readonly MonthlyCostPoint[],
  usagePoints: readonly MonthlyUsagePoint[],
): DeterministicTrendAnalysis {
  const costByMonth = sumByMonth(costPoints.map((point) => ({
    month: point.month,
    value: point.cost,
  })));
  const usageByUnit = new Map<string, { month: string; value: number }[]>();
  for (const point of usagePoints) {
    const points = usageByUnit.get(point.consumedUnit) ?? [];
    points.push({ month: point.month, value: point.consumedQuantity });
    usageByUnit.set(point.consumedUnit, points);
  }

  const cost = latestTrend(costByMonth);
  const usageTrends = [...usageByUnit.entries()]
    .map(([unit, points]) => ({ unit, trend: latestTrend(sumByMonth(points)) }))
    .filter((item): item is { unit: string; trend: DeterministicTrend } => item.trend !== null);
  const signals: string[] = [];
  if (cost === null) signals.push('INSUFFICIENT_COST_TREND_HISTORY');
  if (usageTrends.length === 0) signals.push('INSUFFICIENT_USAGE_TREND_HISTORY');
  if (
    cost !== null
    && usageTrends.some(({ trend }) => (
      Math.abs(cost.changePercent - trend.changePercent) >= 20
      && cost.direction !== trend.direction
    ))
  ) {
    signals.push('COST_USAGE_TREND_DIVERGENCE');
  }

  return {
    cost,
    usageByUnit: usageTrends,
    costMonths: costByMonth.length,
    usageMonths: new Set(usagePoints.map((point) => point.month)).size,
    signals,
  };
}

function sumByMonth(points: readonly { readonly month: string; readonly value: number }[]) {
  const totals = new Map<string, number>();
  for (const point of points) {
    totals.set(point.month, (totals.get(point.month) ?? 0) + point.value);
  }
  return [...totals.entries()]
    .map(([month, value]) => ({ month, value: round(value) }))
    .sort((left, right) => left.month.localeCompare(right.month));
}

function latestTrend(
  points: readonly { readonly month: string; readonly value: number }[],
): DeterministicTrend | null {
  const previous = points.at(-2)?.value;
  const current = points.at(-1)?.value;
  if (previous === undefined || current === undefined) return null;
  const changePercent = previous === 0
    ? current === 0 ? 0 : 100
    : ((current - previous) / Math.abs(previous)) * 100;
  return {
    previous,
    current,
    changePercent: round(changePercent),
    direction: changePercent > 2 ? 'UP' : changePercent < -2 ? 'DOWN' : 'STABLE',
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

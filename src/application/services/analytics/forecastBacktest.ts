import type { MonthlyCostPoint } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { round } from './statistics.js';
import { sortByMonth } from './costSeriesGrouping.js';

/** Accuracy evidence produced by a bounded walk-forward backtest. */
export interface ForecastBacktestMetrics {
  readonly trainingPoints: number;
  readonly evaluatedPoints: number;
  readonly mae: number;
  readonly rmse: number;
  readonly wape?: number;
  readonly naiveWape?: number;
  readonly improvementPercent?: number;
}

/**
 * Evaluates the forecast heuristic without calling an external model.
 * Each prediction only sees points before the evaluated month, preventing
 * future leakage and making the evidence reproducible.
 */
export function evaluateForecastBacktest(
  points: readonly MonthlyCostPoint[],
  minimumTrainingPoints = 3,
): ForecastBacktestMetrics {
  const sorted = sortByMonth(points);
  const trainingPoints = Math.max(3, Math.floor(minimumTrainingPoints));
  const errors: number[] = [];
  const naiveErrors: number[] = [];
  const actuals: number[] = [];

  for (let index = trainingPoints; index < sorted.length; index += 1) {
    const training = sorted.slice(0, index);
    const actual = sorted[index]?.cost;
    const previous = training.at(-1)?.cost;
    if (actual === undefined || previous === undefined) continue;
    errors.push(actual - predictNext(training.map((point) => point.cost)));
    naiveErrors.push(actual - previous);
    actuals.push(actual);
  }

  const mae = errors.length === 0 ? 0 : errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
  const rmse = errors.length === 0 ? 0 : Math.sqrt(errors.reduce((sum, error) => sum + (error ** 2), 0) / errors.length);
  const actualTotal = actuals.reduce((sum, actual) => sum + Math.abs(actual), 0);
  const wape = actualTotal === 0 ? undefined : (errors.reduce((sum, error) => sum + Math.abs(error), 0) / actualTotal) * 100;
  const naiveWape = actualTotal === 0 ? undefined : (naiveErrors.reduce((sum, error) => sum + Math.abs(error), 0) / actualTotal) * 100;
  const improvementPercent = wape === undefined || naiveWape === undefined || naiveWape === 0
    ? undefined
    : ((naiveWape - wape) / naiveWape) * 100;

  return {
    trainingPoints,
    evaluatedPoints: errors.length,
    mae: round(mae, 4),
    rmse: round(rmse, 4),
    ...(wape === undefined ? {} : { wape: round(wape, 4) }),
    ...(naiveWape === undefined ? {} : { naiveWape: round(naiveWape, 4) }),
    ...(improvementPercent === undefined ? {} : { improvementPercent: round(improvementPercent, 4) }),
  };
}

function predictNext(costs: readonly number[]): number {
  const lastThree = costs.slice(-3);
  const weightedAverage = (lastThree[0]! * 0.2) + (lastThree[1]! * 0.3) + (lastThree[2]! * 0.5);
  const monthlyTrend = (lastThree[2]! - lastThree[0]!) / 2;
  return Math.max(0, weightedAverage + monthlyTrend);
}

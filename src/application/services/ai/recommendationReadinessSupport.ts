import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';

const standardMonthDays = 30;

export function getRecommendationPeriodDays(snapshot: CostAnalyticsSnapshot): number {
  const start = new Date(snapshot.periodStart).getTime();
  const end = new Date(snapshot.periodEnd).getTime();
  const elapsedDays = (end - start) / (24 * 60 * 60 * 1000);
  return Number.isFinite(elapsedDays) && elapsedDays > 0
    ? elapsedDays
    : snapshot.coveredDays !== undefined && Number.isFinite(snapshot.coveredDays) && snapshot.coveredDays > 0
      ? snapshot.coveredDays
      : standardMonthDays;
}

export function normalizeMonthlyAmount(amount: number, snapshot: CostAnalyticsSnapshot): number {
  return amount * standardMonthDays / getRecommendationPeriodDays(snapshot);
}

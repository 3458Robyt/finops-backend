import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import type {
  CostTrend,
  MonthlyCostPoint,
} from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { round, roundCurrency } from './statistics.js';
import { groupCostSeries, sortByMonth } from './costSeriesGrouping.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Constructor de tendencias de costo
 * ═══════════════════════════════════════════════════════════════
 *
 * Función pura que resume la evolución de costo por grupo (costo total y
 * variación entre el primer y el último punto). Aislada del servicio para
 * mantener cada cálculo analítico en su propio módulo cohesionado.
 *
 * @module application/services/analytics/costTrendBuilder
 */

/**
 * Construye las tendencias de costo por grupo.
 *
 * Para cada grupo ordena la serie por mes, suma el costo total y calcula el
 * delta absoluto y porcentual entre el primer y el último punto. El resultado
 * se ordena por costo total descendente.
 *
 * @param series - Serie de costo mensual.
 * @returns Tendencias por grupo.
 *
 * @throws {FinOpsBaseError} Con código `ANALYTICS_ERROR` si un grupo resulta vacío (estado inválido).
 */
export function buildTrends(series: readonly MonthlyCostPoint[]): readonly CostTrend[] {
  return [...groupCostSeries(series).entries()]
    .map(([groupKey, points]) => buildGroupTrend(groupKey, points))
    .sort((left, right) => right.totalCost - left.totalCost);
}

/** Construye la tendencia de un único grupo a partir de sus puntos mensuales. */
function buildGroupTrend(groupKey: string, points: readonly MonthlyCostPoint[]): CostTrend {
  const sorted = sortByMonth(points);
  const first = sorted[0];
  const last = sorted.at(-1);

  if (first === undefined || last === undefined) {
    throw new FinOpsBaseError('Invalid empty trend group', 'ANALYTICS_ERROR');
  }

  const totalCost = sorted.reduce((total, point) => total + point.cost, 0);
  const deltaAmount = last.cost - first.cost;
  const deltaPercent = first.cost > 0 ? (deltaAmount / first.cost) * 100 : 0;

  return {
    groupBy: last.groupBy,
    groupKey,
    ...(last.provider !== undefined ? { provider: last.provider } : {}),
    ...(last.cloudAccountId !== undefined ? { cloudAccountId: last.cloudAccountId } : {}),
    ...(last.serviceName !== undefined ? { serviceName: last.serviceName } : {}),
    points: sorted,
    totalCost: roundCurrency(totalCost),
    deltaAmount: roundCurrency(deltaAmount),
    deltaPercent: round(deltaPercent, 4),
    currency: last.currency,
  };
}

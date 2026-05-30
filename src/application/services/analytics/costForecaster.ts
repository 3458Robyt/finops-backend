import type {
  MonthlyCostPoint,
  PersistCostForecastInput,
} from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { roundCurrency, round, standardDeviation } from './statistics.js';
import { groupCostSeries, sortByMonth } from './costSeriesGrouping.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Forecaster de costos
 * ═══════════════════════════════════════════════════════════════
 *
 * Función pura que proyecta el costo de los próximos 3 meses por grupo
 * mediante media móvil ponderada con tendencia lineal. Aislada del
 * servicio para poder probar la heurística de predicción de forma directa.
 *
 * @module application/services/analytics/costForecaster
 */

/**
 * Genera forecasts de costo a 3 meses por grupo mediante media móvil
 * ponderada con tendencia lineal.
 *
 * Algoritmo y heurística (por cada grupo con al menos 3 puntos):
 * - Toma los últimos 3 meses y calcula una media ponderada que prioriza el
 *   más reciente (pesos 0.2 / 0.3 / 0.5).
 * - Estima la tendencia mensual como (último - primero) / (n-1).
 * - Deriva la confianza a partir de la variabilidad: 1 − (desviación / media),
 *   acotada al rango [0.45, 0.9] (mayor dispersión ⇒ menor confianza).
 * - Proyecta los meses +1, +2 y +3 como mediaPonderada + tendencia*offset
 *   (nunca negativo) y construye una banda con un `spread` que crece cuando
 *   la confianza baja, reflejando mayor incertidumbre.
 *
 * Resultado limitado a 60 forecasts. Función pura (no persiste).
 *
 * @param tenantId - Tenant al que se asignan los forecasts.
 * @param series   - Serie de costo mensual ya filtrada/agrupada.
 * @returns Hasta 60 forecasts candidatos listos para persistir.
 */
export function generateForecasts(
  tenantId: string,
  series: readonly MonthlyCostPoint[],
): readonly PersistCostForecastInput[] {
  const byGroup = groupCostSeries(series);
  const forecasts: PersistCostForecastInput[] = [];

  for (const points of byGroup.values()) {
    forecasts.push(...forecastGroup(tenantId, points));
  }

  return forecasts.slice(0, 60);
}

/**
 * Genera los 3 forecasts (meses +1..+3) de un grupo, o un arreglo vacío si el
 * grupo no tiene al menos 3 puntos para modelar tendencia.
 */
function forecastGroup(
  tenantId: string,
  points: readonly MonthlyCostPoint[],
): readonly PersistCostForecastInput[] {
  const sorted = sortByMonth(points);

  if (sorted.length < 3) {
    return [];
  }

  const lastPoint = sorted.at(-1);

  if (lastPoint === undefined) {
    return [];
  }

  const lastThree = sorted.slice(-3);
  const costs = lastThree.map((point) => point.cost);
  const weightedAverage = ((costs[0] ?? 0) * 0.2) + ((costs[1] ?? 0) * 0.3) + ((costs[2] ?? 0) * 0.5);
  const trend = (costs.at(-1) ?? 0) - (costs[0] ?? 0);
  const monthlyTrend = trend / Math.max(lastThree.length - 1, 1);
  const variance = standardDeviation(costs);
  const confidence = Math.max(0.45, Math.min(0.9, 1 - (variance / Math.max(weightedAverage, 1))));
  const lastMonth = new Date(lastPoint.month);
  const forecasts: PersistCostForecastInput[] = [];

  for (let offset = 1; offset <= 3; offset += 1) {
    const forecastMonth = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + offset, 1));
    const predictedCost = Math.max(0, weightedAverage + (monthlyTrend * offset));
    const spread = Math.max(variance, predictedCost * (1 - confidence));

    forecasts.push({
      tenantId,
      ...(lastPoint.cloudAccountId !== undefined ? { cloudAccountId: lastPoint.cloudAccountId } : {}),
      ...(lastPoint.provider !== undefined ? { provider: lastPoint.provider } : {}),
      ...(lastPoint.serviceName !== undefined ? { serviceName: lastPoint.serviceName } : {}),
      groupBy: lastPoint.groupBy,
      groupKey: lastPoint.groupKey,
      forecastMonth,
      predictedCost: roundCurrency(predictedCost),
      lowerBound: roundCurrency(Math.max(0, predictedCost - spread)),
      upperBound: roundCurrency(predictedCost + spread),
      method: 'weighted-moving-average-linear-trend',
      confidence: round(confidence, 4),
      currency: lastPoint.currency,
      evidence: {
        sourceMonths: lastThree.map((point) => point.month),
        weightedAverage: roundCurrency(weightedAverage),
        monthlyTrend: roundCurrency(monthlyTrend),
      },
    });
  }

  return forecasts;
}

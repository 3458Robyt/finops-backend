import type {
  MonthlyCostPoint,
  MonthlyUsagePoint,
} from '../../../domain/interfaces/ICostAnalyticsRepository.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Agrupación de series de costo y consumo
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras que agrupan los puntos de las series mensuales por su
 * clave lógica, paso previo común a la detección de anomalías, el
 * forecasting y la construcción de tendencias e insights.
 *
 * @module application/services/analytics/costSeriesGrouping
 */

/**
 * Agrupa la serie de costo por `groupKey`.
 *
 * @returns Mapa de groupKey a sus puntos de costo.
 */
export function groupCostSeries(series: readonly MonthlyCostPoint[]): Map<string, MonthlyCostPoint[]> {
  const groups = new Map<string, MonthlyCostPoint[]>();

  for (const point of series) {
    const key = point.groupKey;
    const existing = groups.get(key) ?? [];
    existing.push(point);
    groups.set(key, existing);
  }

  return groups;
}

/**
 * Agrupa la serie de consumo por la clave compuesta `groupBy:groupKey:unidad`.
 *
 * Incluir la unidad en la clave evita mezclar consumos de distinta naturaleza
 * (p. ej. GB-mes y peticiones) dentro de un mismo grupo de tendencia.
 *
 * @returns Mapa de clave compuesta a sus puntos de consumo.
 */
export function groupUsageSeries(series: readonly MonthlyUsagePoint[]): Map<string, MonthlyUsagePoint[]> {
  const groups = new Map<string, MonthlyUsagePoint[]>();

  for (const point of series) {
    const key = `${point.groupBy}:${point.groupKey}:${point.consumedUnit}`;
    const existing = groups.get(key) ?? [];
    existing.push(point);
    groups.set(key, existing);
  }

  return groups;
}

/** Ordena (sin mutar) una copia de los puntos de costo por mes ascendente. */
export function sortByMonth<T extends { readonly month: string }>(points: readonly T[]): T[] {
  return [...points].sort((left, right) => left.month.localeCompare(right.month));
}

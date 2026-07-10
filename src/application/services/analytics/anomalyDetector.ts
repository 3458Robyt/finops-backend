import type {
  CostAnomalySeverity,
  MonthlyCostPoint,
  PersistCostAnomalyInput,
} from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { average, round, roundCurrency, standardDeviation } from './statistics.js';
import { groupCostSeries, sortByMonth } from './costSeriesGrouping.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Detector de anomalías de costo
 * ═══════════════════════════════════════════════════════════════
 *
 * Función pura que detecta anomalías de costo por grupo comparando el
 * último mes con su historia reciente. Se extrae del servicio para aislar
 * la heurística estadística y poder probarla de forma independiente.
 *
 * @module application/services/analytics/anomalyDetector
 */

/** Umbrales configurables que gobiernan la detección y la severidad. */
export interface AnomalyThresholds {
  /** Delta absoluto mínimo (USD) para considerar una anomalía; filtra ruido. */
  readonly minAbsoluteDelta: number;
  /** Incremento porcentual a partir del cual la severidad es MEDIUM. */
  readonly mediumDeltaPercent: number;
  /** Incremento porcentual a partir del cual la severidad es HIGH. */
  readonly highDeltaPercent: number;
  /** Incremento porcentual a partir del cual la severidad es CRITICAL. */
  readonly criticalDeltaPercent: number;
}

/**
 * Detecta anomalías de costo por grupo comparando el último mes contra su
 * historia reciente.
 *
 * Algoritmo y heurística (por cada grupo):
 * - Ordena los puntos por mes y toma como ventana de baseline los hasta 7
 *   meses previos al último (excluyendo el actual).
 * - Calcula la línea base (media), la desviación estándar, el delta absoluto
 *   y porcentual respecto a la baseline, y el z-score (si hay desviación > 0).
 * - Descarta el punto si el delta absoluto es menor que `minAbsoluteDelta`
 *   (USD), o si el incremento porcentual es < `mediumDeltaPercent` y el
 *   z-score < 1.5 (filtra ruido de bajo impacto y poca significancia estadística).
 * - Asigna severidad con {@link scoreAnomalySeverity} y registra evidencia del
 *   método usado ("z-score + delta" o "delta-threshold").
 *
 * Resultado: ordena por mayor delta absoluto y limita a las 25 principales.
 * Función pura (no persiste); el llamador decide la persistencia.
 *
 * @param tenantId   - Tenant al que se asignan las anomalías detectadas.
 * @param series     - Serie de costo mensual ya filtrada/agrupada.
 * @param thresholds - Umbrales de detección y severidad.
 * @returns Hasta 25 anomalías candidatas listas para persistir.
 */
export function detectAnomalies(
  tenantId: string,
  series: readonly MonthlyCostPoint[],
  thresholds: AnomalyThresholds,
): readonly PersistCostAnomalyInput[] {
  const byGroup = groupCostSeries(series);
  const detected: PersistCostAnomalyInput[] = [];

  for (const points of byGroup.values()) {
    const anomaly = detectGroupAnomaly(tenantId, points, thresholds);

    if (anomaly !== null) {
      detected.push(anomaly);
    }
  }

  return detected
    .sort((left, right) => right.deltaAmount - left.deltaAmount)
    .slice(0, 25);
}

/**
 * Evalúa un único grupo y devuelve su anomalía candidata, o `null` si el
 * grupo no tiene suficiente historia o no supera los umbrales de relevancia.
 */
function detectGroupAnomaly(
  tenantId: string,
  points: readonly MonthlyCostPoint[],
  thresholds: AnomalyThresholds,
): PersistCostAnomalyInput | null {
  const sorted = sortByMonth(points);

  if (sorted.length < 2) {
    return null;
  }

  const current = sorted.at(-1);
  const history = sorted.slice(Math.max(0, sorted.length - 7), -1);

  if (current === undefined || history.length === 0) {
    return null;
  }

  const costs = history.map((point) => point.cost);
  const baseline = average(costs);
  const stddev = standardDeviation(costs);
  const deltaAmount = current.cost - baseline;
  const deltaPercent = baseline > 0 ? (deltaAmount / baseline) * 100 : 0;
  const zScore = stddev > 0 ? deltaAmount / stddev : undefined;

  if (
    deltaAmount < thresholds.minAbsoluteDelta ||
    (deltaPercent < thresholds.mediumDeltaPercent && (zScore ?? 0) < 1.5)
  ) {
    return null;
  }

  const periodStart = new Date(current.month);
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));

  return {
    tenantId,
    ...(current.cloudAccountId !== undefined ? { cloudAccountId: current.cloudAccountId } : {}),
    ...(current.provider !== undefined ? { provider: current.provider } : {}),
    ...(current.serviceName !== undefined ? { serviceName: current.serviceName } : {}),
    ...(current.resourceId !== undefined ? { resourceId: current.resourceId } : {}),
    ...(current.environment !== undefined ? { environment: current.environment } : {}),
    periodStart,
    periodEnd,
    baselineCost: roundCurrency(baseline),
    observedCost: roundCurrency(current.cost),
    deltaAmount: roundCurrency(deltaAmount),
    deltaPercent: round(deltaPercent, 4),
    ...(zScore !== undefined ? { zScore: round(zScore, 4) } : {}),
    severity: scoreAnomalySeverity(deltaPercent, zScore, thresholds),
    status: 'OPEN',
    explanation: `Oportunidad de costo en ${current.groupBy} ${current.groupKey}: ${round(deltaPercent, 1)}% sobre la linea base.`,
    evidence: {
      groupBy: current.groupBy,
      groupKey: current.groupKey,
      historyMonths: history.length,
      method: zScore !== undefined ? 'z-score + delta' : 'delta-threshold',
      currency: current.currency,
    },
  };
}

/**
 * Asigna la severidad de una anomalía combinando el incremento porcentual y
 * el z-score (significancia estadística), tomando el criterio más alto que se
 * cumpla:
 * - CRITICAL: delta ≥ `criticalDeltaPercent`% o z-score ≥ 3.
 * - HIGH: delta ≥ `highDeltaPercent`% o z-score ≥ 2.
 * - MEDIUM: delta ≥ `mediumDeltaPercent`% o z-score ≥ 1.5.
 * - LOW: en otro caso.
 */
export function scoreAnomalySeverity(
  deltaPercent: number,
  zScore: number | undefined,
  thresholds: AnomalyThresholds,
): CostAnomalySeverity {
  if (deltaPercent >= thresholds.criticalDeltaPercent || (zScore ?? 0) >= 3) {
    return 'CRITICAL';
  }

  if (deltaPercent >= thresholds.highDeltaPercent || (zScore ?? 0) >= 2) {
    return 'HIGH';
  }

  if (deltaPercent >= thresholds.mediumDeltaPercent || (zScore ?? 0) >= 1.5) {
    return 'MEDIUM';
  }

  return 'LOW';
}

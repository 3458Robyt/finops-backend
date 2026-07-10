import type {
  MonthlyUsagePoint,
  UsageInsight,
  UsageInsightSeverity,
} from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { percentDelta, round, roundCurrency } from './statistics.js';
import { groupUsageSeries, sortByMonth } from './costSeriesGrouping.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Constructor de insights de eficiencia de consumo
 * ═══════════════════════════════════════════════════════════════
 *
 * Función pura que deriva señales de eficiencia (crecimiento de consumo,
 * subida de costo unitario, divergencia costo-consumo, etc.) a partir de la
 * serie de consumo mensual FOCUS. Aislada del servicio para concentrar aquí
 * todas las heurísticas de insights y sus umbrales.
 *
 * @module application/services/analytics/usageInsightBuilder
 */

/**
 * Construye insights de eficiencia de consumo a partir de la serie de uso.
 *
 * Agrupa por (groupBy:groupKey:unidad) y, comparando el primer y el último
 * punto de cada grupo, aplica varias heurísticas (umbrales basados en FOCUS):
 * - `INSUFFICIENT_USAGE_DATA`: un solo periodo, no hay tendencia comparable.
 * - `CONSUMPTION_GROWTH`: el consumo crece ≥ 30% (señal de demanda a validar).
 * - `UNIT_COST_INCREASE`: el costo unitario sube ≥ 20% (revisar descuentos/precio).
 * - `COST_USAGE_DIVERGENCE`: el costo crece ≥ 25 puntos porcentuales más que
 *   el consumo (requiere investigación antes de estimar ahorro).
 * - `HIGH_USAGE_LOW_COST`: consumo > 0 con costo cero (señal, no ahorro directo).
 *
 * El resultado se ordena por severidad descendente y se limita a 25 insights.
 *
 * @param series - Serie de consumo mensual.
 * @returns Insights de consumo priorizados.
 */
export function buildUsageInsights(series: readonly MonthlyUsagePoint[]): readonly UsageInsight[] {
  if (series.length === 0) {
    return [];
  }

  const insights: UsageInsight[] = [];

  for (const points of groupUsageSeries(series).values()) {
    insights.push(...buildGroupInsights(points));
  }

  return insights
    .sort((left, right) => usageSeverityWeight(right.severity) - usageSeverityWeight(left.severity))
    .slice(0, 25);
}

/** Construye los insights de un único grupo de consumo (clave + unidad). */
function buildGroupInsights(points: readonly MonthlyUsagePoint[]): readonly UsageInsight[] {
  const sorted = sortByMonth(points);
  const first = sorted[0];
  const current = sorted.at(-1);

  if (first === undefined || current === undefined) {
    return [];
  }

  if (sorted.length < 2) {
    return [toUsageInsight({
      point: current,
      kind: 'INSUFFICIENT_USAGE_DATA',
      severity: 'INFO',
      title: `Datos de consumo insuficientes para ${current.groupKey}`,
      description: `FOCUS trae consumo en ${current.consumedUnit}, pero solo hay ${sorted.length} periodo disponible para comparar tendencia.`,
    })];
  }

  const deltaConsumptionPercent = percentDelta(first.consumedQuantity, current.consumedQuantity);
  const deltaCostPercent = percentDelta(first.cost, current.cost);
  const deltaUnitCostPercent = percentDelta(first.unitCost ?? 0, current.unitCost ?? 0);
  const insights: UsageInsight[] = [];

  if (deltaConsumptionPercent >= 30 && current.consumedQuantity > first.consumedQuantity) {
    insights.push(toUsageInsight({
      point: current,
      kind: 'CONSUMPTION_GROWTH',
      severity: scoreUsageSeverity(deltaConsumptionPercent),
      title: `Consumo creciente en ${current.groupKey}`,
      description: `El consumo FOCUS aumento ${round(deltaConsumptionPercent, 1)}% en ${current.consumedUnit}; validar si el crecimiento corresponde a demanda real.`,
      deltaConsumptionPercent,
      deltaCostPercent,
    }));
  }

  if (deltaUnitCostPercent >= 20 && current.unitCost !== undefined && first.unitCost !== undefined) {
    insights.push(toUsageInsight({
      point: current,
      kind: 'UNIT_COST_INCREASE',
      severity: scoreUsageSeverity(deltaUnitCostPercent),
      title: `Costo unitario creciente en ${current.groupKey}`,
      description: `El costo por ${current.consumedUnit} aumento ${round(deltaUnitCostPercent, 1)}%; revisar descuentos, forma de consumo o cambios de precio.`,
      deltaConsumptionPercent,
      deltaCostPercent,
    }));
  }

  if (deltaCostPercent - deltaConsumptionPercent >= 25 && current.cost > 0) {
    insights.push(toUsageInsight({
      point: current,
      kind: 'COST_USAGE_DIVERGENCE',
      severity: scoreUsageSeverity(deltaCostPercent - deltaConsumptionPercent),
      title: `Costo crece mas que el consumo en ${current.groupKey}`,
      description: `El costo aumento ${round(deltaCostPercent, 1)}% y el consumo ${round(deltaConsumptionPercent, 1)}%; requiere investigacion antes de estimar ahorro.`,
      deltaConsumptionPercent,
      deltaCostPercent,
    }));
  }

  if (current.consumedQuantity > 0 && current.cost === 0) {
    insights.push(toUsageInsight({
      point: current,
      kind: 'HIGH_USAGE_LOW_COST',
      severity: 'LOW',
      title: `Consumo sin costo directo en ${current.groupKey}`,
      description: `FOCUS reporta ${round(current.consumedQuantity, 2)} ${current.consumedUnit} con costo cero; conservarlo como senal de consumo, no como ahorro directo.`,
      deltaConsumptionPercent,
      deltaCostPercent,
    }));
  }

  return insights;
}

/**
 * Normaliza un punto de consumo en un {@link UsageInsight} completo.
 *
 * Genera un `id` determinista (kind:groupBy:groupKey:mes), redondea las
 * magnitudes, fija `evidenceLevel` en `COST_AND_USAGE` y adjunta evidencia
 * que recuerda la limitación de FOCUS (no aporta CPU, memoria, IOPS ni
 * throughput).
 */
function toUsageInsight(input: {
  readonly point: MonthlyUsagePoint;
  readonly kind: UsageInsight['kind'];
  readonly severity: UsageInsightSeverity;
  readonly title: string;
  readonly description: string;
  readonly deltaConsumptionPercent?: number;
  readonly deltaCostPercent?: number;
}): UsageInsight {
  const { point } = input;

  return {
    id: [
      input.kind,
      point.groupBy,
      point.groupKey,
      point.month.slice(0, 10),
    ].join(':'),
    kind: input.kind,
    severity: input.severity,
    groupBy: point.groupBy,
    groupKey: point.groupKey,
    ...(point.provider !== undefined ? { provider: point.provider } : {}),
    ...(point.cloudAccountId !== undefined ? { cloudAccountId: point.cloudAccountId } : {}),
    ...(point.serviceName !== undefined ? { serviceName: point.serviceName } : {}),
    ...(point.resourceId !== undefined ? { resourceId: point.resourceId } : {}),
    ...(point.environment !== undefined ? { environment: point.environment } : {}),
    title: input.title,
    description: input.description,
    consumedQuantity: round(point.consumedQuantity, 4),
    consumedUnit: point.consumedUnit,
    cost: roundCurrency(point.cost),
    ...(point.unitCost !== undefined ? { unitCost: round(point.unitCost, 8) } : {}),
    ...(input.deltaConsumptionPercent !== undefined ? { deltaConsumptionPercent: round(input.deltaConsumptionPercent, 4) } : {}),
    ...(input.deltaCostPercent !== undefined ? { deltaCostPercent: round(input.deltaCostPercent, 4) } : {}),
    evidenceLevel: 'COST_AND_USAGE',
    currency: point.currency,
    evidence: {
      source: 'FOCUS',
      limitation: 'FOCUS aporta consumo facturado, no metricas tecnicas como CPU, memoria, IOPS o throughput.',
      month: point.month,
      metricCount: point.metricCount,
    },
  };
}

/**
 * Mapea un delta porcentual a severidad de insight de consumo: HIGH si ≥ 100%,
 * MEDIUM si ≥ 50%, LOW en otro caso.
 */
function scoreUsageSeverity(deltaPercent: number): UsageInsightSeverity {
  if (deltaPercent >= 100) {
    return 'HIGH';
  }

  if (deltaPercent >= 50) {
    return 'MEDIUM';
  }

  return 'LOW';
}

/**
 * Peso numérico de una severidad de insight, usado para ordenar de mayor a
 * menor prioridad (HIGH=3, MEDIUM=2, LOW=1, INFO=0).
 */
function usageSeverityWeight(severity: UsageInsightSeverity): number {
  switch (severity) {
    case 'HIGH':
      return 3;
    case 'MEDIUM':
      return 2;
    case 'LOW':
      return 1;
    case 'INFO':
    default:
      return 0;
  }
}

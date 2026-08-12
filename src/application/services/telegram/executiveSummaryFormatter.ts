import type { ExecutiveSummary } from '../../../domain/interfaces/IExecutiveSummaryService.js';
import { formatCurrency, formatDate } from './telegramMessageFormatters.js';

/** Renderiza un resumen ejecutivo acotado, auditable y compartible por canales externos. */
export function formatExecutiveSummary(summary: ExecutiveSummary): string {
  const top = summary.opportunities.top.length === 0
    ? '- No hay oportunidades con ahorro estimado.'
    : summary.opportunities.top.map((item, index) => `${index + 1}. ${item.title} — ${formatCurrency(item.estimatedMonthlySavings, item.currency)}/mes (${item.status})`).join('\n');
  const potential = Object.entries(summary.opportunities.potentialByCurrency)
    .map(([currency, amount]) => `${formatCurrency(amount, currency)}/mes`)
    .join(', ') || 'Sin cuantificar';
  const nextTrend = summary.forecastScenarios.find((item) => item.scenario === 'CURRENT_TREND');
  const verified = summary.realization.currencies.map((item) => `${formatCurrency(item.verifiedMonthlySavings, item.currency)}/mes`).join(', ') || 'Sin mediciones verificadas';

  return [
    'Resumen ejecutivo FinOps',
    `Periodo de costos: ${formatDate(summary.periodStart)} a ${formatDate(summary.periodEnd)}`,
    `Costo total: ${formatCurrency(summary.totalCost, summary.currency)}`,
    summary.variationPercent === undefined ? 'Variación mensual: No disponible' : `Variación mensual: ${summary.variationPercent.toFixed(2)}%`,
    '',
    `Oportunidades activas: ${summary.opportunities.count}`,
    `Ahorro potencial estimado: ${potential}`,
    'Principales oportunidades:',
    top,
    '',
    `Forecast actual: ${nextTrend === undefined ? 'No disponible' : `${formatCurrency(nextTrend.predictedCost, nextTrend.currency)} para ${formatDate(nextTrend.forecastMonth)}`}`,
    `Ahorro ejecutado medido: ${summary.realization.currencies.map((item) => formatCurrency(item.projectedMonthlySavings, item.currency)).join(', ') || 'No disponible'}`,
    `Ahorro verificado: ${verified}`,
    '',
    `Presupuestos activos: ${summary.budgets.reduce((total, item) => total + item.active, 0)}`,
    `Presupuestos en riesgo: ${summary.budgets.reduce((total, item) => total + item.atRisk + item.exceeded, 0)}`,
    `Cobertura costos: ${summary.coverage.costPercent.toFixed(1)}% · métricas: ${summary.coverage.metricsPercent.toFixed(1)}%`,
    `Conexiones con ingesta bloqueada: ${summary.ingestion.blockedConnections}`,
  ].join('\n');
}

import type { InAppNotification } from '../../../domain/models/InAppNotification.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Formateadores de mensajes del bot de Telegram FinOps
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras que componen el texto en español de las respuestas del bot
 * (recordatorios de ahorro, recomendaciones, costos y oportunidades) a partir
 * de los datos ya recuperados por el servicio, además de utilidades de formato
 * de moneda, fecha y vista previa. Aíslan la presentación del orquestador y no
 * importan del servicio, evitando dependencias circulares.
 *
 * @module application/services/telegram/telegramMessageFormatters
 */

/** Formateador de moneda reutilizable para importes en USD. */
const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

/**
 * Formatea hasta 5 recordatorios de ahorro no capturado para mostrarlos en el
 * chat, incluyendo el importe perdido cuando está disponible.
 *
 * @param notifications - Recordatorios de ahorro del usuario ya recuperados.
 * @returns El texto con los recordatorios, o un aviso si no hay ninguno activo.
 */
export function formatSavingsReminders(notifications: readonly InAppNotification[]): string {
  if (notifications.length === 0) {
    return 'No hay recordatorios de ahorro activos para este usuario.';
  }

  const lines = notifications.slice(0, 5).map((notification, index) => [
    `${index + 1}. ${notification.title}`,
    notification.message,
    notification.missedSavingsAmount !== undefined
      ? `Ahorro no capturado: ${formatCurrency(notification.missedSavingsAmount, notification.currency)}`
      : undefined,
  ].filter((line): line is string => line !== undefined).join('\n'));

  return ['Recordatorios de ahorro:', '', ...lines].join('\n\n');
}

/**
 * Formatea las recomendaciones activas (PENDING o APPROVED) del tenant,
 * ordenadas de mayor a menor ahorro mensual estimado y limitadas a 5.
 *
 * @param recommendations - Recomendaciones del tenant ya recuperadas.
 * @returns El texto con las recomendaciones, o un aviso si no hay ninguna activa.
 */
export function formatRecommendations(recommendations: readonly FinOpsRecommendation[]): string {
  const active = recommendations
    .filter((recommendation) => recommendation.status === 'PENDING' || recommendation.status === 'APPROVED')
    .sort((left, right) => (right.estimatedMonthlySavings ?? 0) - (left.estimatedMonthlySavings ?? 0))
    .slice(0, 5);

  if (active.length === 0) {
    return 'No hay recomendaciones pendientes o aprobadas en este momento.';
  }

  return [
    'Recomendaciones activas:',
    '',
    ...active.map((recommendation, index) => formatRecommendationLine(recommendation, index)),
  ].join('\n\n');
}

/**
 * Formatea un resumen de costos del tenant a partir del último snapshot:
 * periodo, costo total, nº de métricas y los principales proveedores (top 3)
 * y servicios (top 5).
 *
 * @param snapshot - Snapshot de costos del tenant ya recuperado.
 * @returns El texto con el resumen de costos.
 */
export function formatCosts(snapshot: CostAnalyticsSnapshot): string {
  const providers = snapshot.providers
    .slice(0, 3)
    .map((provider) => `- ${provider.provider}: ${formatCurrency(provider.totalCost, snapshot.currency)}`)
    .join('\n');
  const services = snapshot.services
    .slice(0, 5)
    .map((service) => `- ${service.serviceName}: ${formatCurrency(service.totalCost, snapshot.currency)}`)
    .join('\n');

  return [
    'Resumen de costos FinOps:',
    `Periodo: ${formatDate(snapshot.periodStart)} a ${formatDate(snapshot.periodEnd)}`,
    `Costo total: ${formatCurrency(snapshot.totalCost, snapshot.currency)}`,
    `Metricas: ${snapshot.metricCount}`,
    '',
    'Proveedores principales:',
    providers !== '' ? providers : '- Sin datos',
    '',
    'Servicios principales:',
    services !== '' ? services : '- Sin datos',
  ].join('\n');
}

/**
 * Formatea las oportunidades detectadas combinando anomalías (top 3) e
 * insights de uso (top 5) del último snapshot, limitando el total a 5 líneas.
 *
 * @param snapshot - Snapshot de costos del tenant ya recuperado.
 * @returns El texto con las oportunidades, o un aviso si no hay evidencia disponible.
 */
export function formatOpportunities(snapshot: CostAnalyticsSnapshot): string {
  const anomalyLines = (snapshot.anomalies ?? []).slice(0, 3).map((opportunity) => (
    `- ${opportunity.explanation} (${formatCurrency(opportunity.deltaAmount, snapshot.currency)})`
  ));
  const insightLines = (snapshot.usageInsights ?? []).slice(0, 3).map((insight) => (
    `- ${insight.title}: ${insight.description}`
  ));
  const lines = [...anomalyLines, ...insightLines].slice(0, 5);

  if (lines.length === 0) {
    return 'No hay oportunidades activas con la evidencia disponible.';
  }

  return ['Oportunidades detectadas:', '', ...lines].join('\n');
}

/**
 * Formatea una única recomendación como bloque de texto numerado (título,
 * estado, ahorro estimado mensual y severidad) para los listados del chat.
 */
export function formatRecommendationLine(recommendation: FinOpsRecommendation, index: number): string {
  const savings = recommendation.estimatedMonthlySavings !== undefined
    ? formatCurrency(recommendation.estimatedMonthlySavings, recommendation.currency)
    : 'Ahorro no estimado';

  return [
    `${index + 1}. ${recommendation.title}`,
    `Estado: ${recommendation.status}`,
    `Ahorro estimado: ${savings}/mes`,
    `Severidad: ${recommendation.severity}`,
  ].join('\n');
}

/** Recorta el texto a 240 caracteres (con sufijo `...`) para la vista previa del log. */
export function truncatePreview(value: string): string {
  return value.length <= 240 ? value : value.slice(0, 237).concat('...');
}

/** Formatea una fecha ISO al formato de fecha local de Colombia (es-CO). */
export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('es-CO');
}

/**
 * Formatea un importe monetario. Usa el formateador localizado para USD y, para
 * cualquier otra moneda, antepone el código de moneda al valor con dos decimales.
 */
export function formatCurrency(value: number, currency: string): string {
  if (currency === 'USD') {
    return currencyFormatter.format(value);
  }

  return `${currency} ${value.toFixed(2)}`;
}

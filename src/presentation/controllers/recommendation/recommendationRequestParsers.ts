import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { RecommendationFeedbackReason } from '../../../domain/models/AgentLearning.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';

/**
 * Funciones puras de parseo y validación de los datos de entrada (parámetros de
 * ruta, query string y cuerpo) de las peticiones del controlador de
 * recomendaciones FinOps.
 *
 * Estas utilidades no dependen del estado del controlador ni de Express: reciben
 * valores `unknown` y devuelven valores normalizados o `undefined`, lo que las
 * hace reutilizables y fáciles de testear. El controlador las importa para
 * validar la entrada antes de delegar en el repositorio y los servicios.
 *
 * Importante: ninguna de estas funciones importa desde el controlador, evitando
 * dependencias circulares.
 */

/** Conjunto de estados soportados para una ejecución manual de recomendación. */
const supportedManualExecutionStatuses = new Set([
  'PLANNED',
  'EXECUTED',
  'PARTIAL',
  'CANCELLED',
]);

/** Conjunto de estados de recomendación soportados en los filtros de listado. */
const supportedStatuses = new Set<FinOpsRecommendation['status']>([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'MANUAL_COMPLETED',
]);

/**
 * Normaliza un valor de entrada a string: devuelve la cadena recortada si es
 * un texto no vacío, o `undefined` en cualquier otro caso.
 */
export function parseString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}

/**
 * Normaliza y valida la decisión del cuerpo de la petición (en mayúsculas).
 * Devuelve `APPROVED` o `REJECTED`, o `undefined` si el valor no es válido.
 */
export function parseDecision(value: unknown): 'APPROVED' | 'REJECTED' | undefined {
  const decision = parseString(value)?.toUpperCase();

  if (decision === 'APPROVED' || decision === 'REJECTED') {
    return decision;
  }

  return undefined;
}

/**
 * Normaliza y valida el estado de una ejecución manual (en mayúsculas) contra
 * el conjunto soportado ({@link supportedManualExecutionStatuses}). Devuelve
 * el estado válido o `undefined`.
 */
export function parseManualExecutionStatus(
  value: unknown,
): 'PLANNED' | 'EXECUTED' | 'PARTIAL' | 'CANCELLED' | undefined {
  const status = parseString(value)?.toUpperCase();

  if (status !== undefined && supportedManualExecutionStatuses.has(status)) {
    return status as 'PLANNED' | 'EXECUTED' | 'PARTIAL' | 'CANCELLED';
  }

  return undefined;
}

/**
 * Convierte un valor en fecha. Devuelve `undefined` si no se proporciona o si
 * la cadena no representa una fecha válida (no lanza error; entrada tolerante).
 */
export function parseDate(value: unknown): Date | undefined {
  const raw = parseString(value);

  if (raw === undefined) {
    return undefined;
  }

  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date;
}

/**
 * Convierte un valor en número finito. Acepta números directamente y cadenas
 * parseables con `parseFloat`; devuelve `undefined` si no es convertible.
 */
export function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

/**
 * Normaliza y valida el código de motivo de feedback (en mayúsculas) contra el
 * conjunto de motivos soportados de aprobación/rechazo. Devuelve el código
 * válido o `undefined`.
 */
export function parseReasonCode(value: unknown): RecommendationFeedbackReason | undefined {
  const reasonCode = parseString(value)?.toUpperCase();
  const supportedReasons = new Set<RecommendationFeedbackReason>([
    'APPROVED_HIGH_CONFIDENCE',
    'APPROVED_LOW_RISK_QUICK_WIN',
    'REJECTED_INSUFFICIENT_EVIDENCE',
    'REJECTED_SAVINGS_UNREALISTIC',
    'REJECTED_OPERATIONAL_RISK',
    'REJECTED_BUSINESS_EXCEPTION',
    'REJECTED_ALREADY_HANDLED',
    'REJECTED_WRONG_SCOPE',
    'REJECTED_NOT_ACTIONABLE',
  ]);

  if (reasonCode !== undefined && supportedReasons.has(reasonCode as RecommendationFeedbackReason)) {
    return reasonCode as RecommendationFeedbackReason;
  }

  return undefined;
}

/**
 * Normaliza y valida el estado de recomendación de la query (en mayúsculas)
 * contra el conjunto soportado ({@link supportedStatuses}). Devuelve
 * `undefined` si no se proporciona, o lanza VALIDATION_ERROR si el valor no es válido.
 */
export function parseStatus(value: unknown): FinOpsRecommendation['status'] | undefined {
  const status = parseString(value)?.toUpperCase();

  if (status === undefined) {
    return undefined;
  }

  if (!supportedStatuses.has(status as FinOpsRecommendation['status'])) {
    throw new FinOpsBaseError(`Invalid recommendation status: ${status}`, 'VALIDATION_ERROR');
  }

  return status as FinOpsRecommendation['status'];
}

/**
 * Lee de forma segura un valor por clave desde el cuerpo de la petición.
 * Devuelve `undefined` si el cuerpo no es un objeto plano (nulo, no objeto o array).
 */
export function readBodyValue(body: unknown, key: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  return (body as Record<string, unknown>)[key];
}

import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { CreateRecommendationInput } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import type { AiRecommendationDraft } from './finOpsAiTypes.js';
import {
  extractJson,
  isRecord,
  readNumber,
  readString,
  readStringList,
} from './jsonReadHelpers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Parser y validador de respuestas de la IA FinOps
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras que transforman y validan las respuestas crudas del
 * modelo IA (texto JSON, posiblemente con cercos Markdown) en estructuras
 * de dominio seguras: borradores de recomendación, planes de ejecución y
 * reportes de auditoría. Centralizar el parsing aquí mantiene el servicio
 * enfocado en la orquestación y facilita probar los casos borde.
 *
 * @module application/services/ai/finOpsAiResponseParser
 */

/** Severidades válidas que la IA puede asignar a una recomendación. */
const supportedSeverities = new Set<FinOpsRecommendation['severity']>([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);

/**
 * Parsea y valida la respuesta JSON de la IA a borradores de recomendación.
 *
 * Extrae el array `recommendations`, valida cada elemento con
 * {@link toRecommendationDraft} (restringiendo las cuentas a las del
 * snapshot) y descarta los inválidos.
 *
 * @throws {FinOpsBaseError} Con código `AI_RESPONSE_ERROR` si no queda ningún
 *         borrador válido tras el filtrado.
 */
export function parseRecommendationDrafts(
  rawResponse: string,
  snapshot: CostAnalyticsSnapshot,
): readonly AiRecommendationDraft[] {
  const json = extractJson(rawResponse);
  const parsed = JSON.parse(json) as unknown;
  const container = isRecord(parsed) ? parsed : {};
  const rawRecommendations = Array.isArray(container['recommendations'])
    ? container['recommendations']
    : [];

  const allowedAccountIds = new Set(snapshot.accounts.map((account) => account.cloudAccountId));

  const drafts = rawRecommendations
    .map((item) => toRecommendationDraft(item, allowedAccountIds, snapshot.currency))
    .filter((item): item is AiRecommendationDraft => item !== null);

  if (drafts.length === 0) {
    throw new FinOpsBaseError('AI did not return valid recommendations', 'AI_RESPONSE_ERROR');
  }

  return drafts;
}

/**
 * Parsea y valida la respuesta JSON de la IA a un plan de ejecución.
 *
 * Verifica que existan los campos array obligatorios (prerrequisitos, pasos,
 * validación, riesgos, rollback y criterios de éxito) con cadenas no vacías,
 * además de `summary`, `scope` y `estimatedSavings`. Inyecta los metadatos de
 * trazabilidad (recommendationId, cloudAccountId, generadoPor).
 *
 * @throws {FinOpsBaseError} Con código `AI_RESPONSE_ERROR` si el plan no es
 *         un objeto válido o le faltan campos obligatorios.
 */
export function parseExecutionPlan(
  rawResponse: string,
  recommendation: FinOpsRecommendation,
): Record<string, unknown> {
  const json = extractJson(rawResponse);
  const parsed = JSON.parse(json) as unknown;

  if (!isRecord(parsed)) {
    throw new FinOpsBaseError('AI did not return a valid execution plan', 'AI_RESPONSE_ERROR');
  }

  const requiredArrayFields = [
    'prerequisites',
    'steps',
    'validation',
    'risks',
    'rollback',
    'successCriteria',
  ];

  const hasRequiredArrays = requiredArrayFields.every((field) => (
    Array.isArray(parsed[field]) &&
    (parsed[field] as unknown[]).every((item) => typeof item === 'string' && item.trim() !== '')
  ));

  if (
    readString(parsed, 'summary') === undefined ||
    !isRecord(parsed['scope']) ||
    !hasRequiredArrays ||
    !isRecord(parsed['estimatedSavings'])
  ) {
    throw new FinOpsBaseError('AI did not return a complete execution plan', 'AI_RESPONSE_ERROR');
  }

  return {
    ...parsed,
    recommendationId: recommendation.id,
    cloudAccountId: recommendation.cloudAccountId,
    generatedBy: 'nvidia-nim',
  };
}

/**
 * Parsea y valida la respuesta del auditor IA a un {@link AiAuditReport}.
 *
 * Normaliza el veredicto a mayúsculas y valida que sea uno de
 * `APPROVED`/`REJECTED`/`NEEDS_REVISION` y que el `score` esté en el rango
 * 0–100. Sanea `checks` (nombre, passed, notas), `blockingIssues` y
 * `requiredChanges`.
 *
 * @throws {FinOpsBaseError} Con código `AI_RESPONSE_ERROR` si el reporte es
 *         inválido o el veredicto/score no cumplen las restricciones.
 */
export function parseAuditReport(rawResponse: string): AiAuditReport {
  const parsed = JSON.parse(extractJson(rawResponse)) as unknown;

  if (!isRecord(parsed)) {
    throw new FinOpsBaseError('AI auditor did not return a valid report', 'AI_RESPONSE_ERROR');
  }

  const verdict = readString(parsed, 'verdict')?.toUpperCase();
  const score = readNumber(parsed, 'score');
  const checks = Array.isArray(parsed['checks']) ? parsed['checks'] : [];
  const blockingIssues = readStringList(parsed['blockingIssues']);
  const requiredChanges = readStringList(parsed['requiredChanges']);

  if (
    (verdict !== 'APPROVED' && verdict !== 'REJECTED' && verdict !== 'NEEDS_REVISION') ||
    score === undefined ||
    score < 0 ||
    score > 100
  ) {
    throw new FinOpsBaseError('AI auditor returned an invalid verdict', 'AI_RESPONSE_ERROR');
  }

  return {
    verdict,
    score,
    checks: checks
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        name: readString(item, 'name') ?? 'verificacion',
        passed: item['passed'] === true,
        notes: readString(item, 'notes') ?? '',
      })),
    blockingIssues,
    requiredChanges,
  };
}

/**
 * Valida y normaliza un elemento crudo de la IA a un borrador de recomendación.
 *
 * Reglas de validación: el `cloudAccountId` debe pertenecer al conjunto
 * permitido (cuentas del snapshot), y `type`, `severity` (dentro de
 * {@link supportedSeverities}), `title` y `description` son obligatorios.
 * Completa la evidencia con la fuente, el `evidenceLevel` (por defecto
 * `COST_AND_USAGE`) y una nota sobre la limitación de FOCUS.
 *
 * @returns El borrador normalizado, o `null` si el elemento es inválido.
 */
export function toRecommendationDraft(
  value: unknown,
  allowedAccountIds: ReadonlySet<string>,
  defaultCurrency: string,
): AiRecommendationDraft | null {
  if (!isRecord(value)) {
    return null;
  }

  const cloudAccountId = readString(value, 'cloudAccountId');
  const type = readString(value, 'type');
  const severity = readString(value, 'severity')?.toUpperCase();
  const title = readString(value, 'title');
  const description = readString(value, 'description');

  if (
    cloudAccountId === undefined ||
    !allowedAccountIds.has(cloudAccountId) ||
    type === undefined ||
    severity === undefined ||
    !supportedSeverities.has(severity as FinOpsRecommendation['severity']) ||
    title === undefined ||
    description === undefined
  ) {
    return null;
  }

  const estimatedMonthlySavings = readNumber(value, 'estimatedMonthlySavings');
  const currency = readString(value, 'currency') ?? defaultCurrency;
  const evidence = isRecord(value['evidence']) ? value['evidence'] : {};
  const evidenceLevel = readEvidenceLevel(evidence) ?? 'COST_AND_USAGE';

  return {
    cloudAccountId,
    type,
    severity: severity as FinOpsRecommendation['severity'],
    title,
    description,
    evidence: {
      source: 'nvidia-nim',
      evidenceLevel,
      focusLimitation: 'FOCUS contiene costo y consumo facturado; no contiene CPU, memoria, IOPS, throughput ni utilizacion tecnica.',
      ...evidence,
    },
    ...(estimatedMonthlySavings !== undefined ? { estimatedMonthlySavings } : {}),
    currency,
  };
}

/**
 * Convierte un borrador en una recomendación efímera (preview) cuando no se
 * persiste. Asigna un id sintético (`ai-preview-N`), estado `PENDING` y
 * marcas de tiempo actuales, sin escribir en el repositorio.
 */
export function toEphemeralRecommendation(
  input: CreateRecommendationInput,
  index: number,
): FinOpsRecommendation {
  const now = new Date();

  return {
    id: `ai-preview-${index + 1}`,
    cloudAccountId: input.cloudAccountId,
    type: input.type,
    status: 'PENDING',
    severity: input.severity,
    title: input.title,
    description: input.description,
    evidence: input.evidence,
    ...(input.estimatedMonthlySavings !== undefined
      ? { estimatedMonthlySavings: input.estimatedMonthlySavings }
      : {}),
    currency: input.currency,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Lee y valida el nivel de evidencia, aceptando solo los valores canónicos
 * `COST_ONLY`, `COST_AND_USAGE` o `COST_USAGE_AND_TECHNICAL` (en mayúsculas).
 * Devuelve `undefined` si el valor no es uno de ellos.
 */
function readEvidenceLevel(record: Record<string, unknown>): string | undefined {
  const raw = readString(record, 'evidenceLevel')?.toUpperCase();

  if (
    raw === 'COST_ONLY' ||
    raw === 'COST_AND_USAGE' ||
    raw === 'COST_USAGE_AND_TECHNICAL'
  ) {
    return raw;
  }

  return undefined;
}

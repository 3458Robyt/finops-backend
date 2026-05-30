import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../../domain/models/FinOpsRecommendation.js';
import type { AiRecommendationDraft } from '../finOpsAiTypes.js';
import { isRecord } from '../jsonReadHelpers.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Rúbrica determinista de calidad del agente IA FinOps
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras que evalúan los artefactos ya parseados del agente
 * (recomendaciones y planes de ejecución) frente a invariantes objetivos del
 * dominio FinOps, sin volver a llamar al modelo. Permiten medir la calidad de
 * forma reproducible (golden scenarios, regresión) antes de cambiar prompts.
 *
 * No sustituye al auditor IA (que evalúa realismo y lenguaje): comprueba reglas
 * deterministas que el auditor podría pasar por alto (alcance de cuentas,
 * honestidad sobre evidencia FOCUS, realismo numérico del ahorro).
 *
 * @module application/services/ai/evaluation/qualityRubric
 */

/** Niveles de evidencia canónicos admitidos en una recomendación. */
const validEvidenceLevels = new Set(['COST_ONLY', 'COST_AND_USAGE', 'COST_USAGE_AND_TECHNICAL']);

/** Severidades válidas de una recomendación. */
const validSeverities = new Set<FinOpsRecommendation['severity']>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/** Frases que delatan una promesa de ejecución automática (prohibida). */
const autoExecutionPhrases = [
  'ejecutara automaticamente',
  'ejecutará automáticamente',
  'remediacion automatica',
  'remediación automática',
  'aplicare el cambio automaticamente',
  'sin intervencion manual',
  'sin intervención manual',
];

/** Resultado de un control individual de la rúbrica. */
export interface QualityCheck {
  /** Identificador estable del control. */
  readonly name: string;
  /** `true` si el control se superó. */
  readonly passed: boolean;
  /** Detalle legible (en español) del resultado. */
  readonly detail: string;
}

/** Reporte agregado de calidad de un artefacto. */
export interface QualityReport {
  /** `true` si todos los controles pasaron. */
  readonly passed: boolean;
  /** Puntuación 0–100 = proporción de controles superados. */
  readonly score: number;
  readonly checks: readonly QualityCheck[];
}

/**
 * Evalúa un conjunto de borradores de recomendación ya parseados frente a la
 * rúbrica determinista, usando el snapshot como fuente de verdad de cuentas y
 * costo total.
 *
 * Controles aplicados (sobre el conjunto):
 * - `count`: hay al menos un borrador (y coincide con `expectedCount` si se indica).
 * - `accountScoping`: todo `cloudAccountId` pertenece a las cuentas del snapshot.
 * - `severityValid`: toda severidad es válida.
 * - `evidenceLevel`: toda evidencia declara un `evidenceLevel` canónico.
 * - `focusHonesty`: si el nivel es `COST_ONLY`, se exige
 *   `evidence.requiresTechnicalValidation === true` (no prometer rightsizing
 *   técnico con solo FOCUS).
 * - `savingsRealism`: el ahorro estimado (si existe) está en `[0, totalCost]`.
 * - `spanishText`: `title` y `description` no están vacíos.
 */
export function evaluateRecommendationDrafts(
  drafts: readonly AiRecommendationDraft[],
  snapshot: CostAnalyticsSnapshot,
  expectedCount?: number,
): QualityReport {
  const allowedAccounts = new Set(snapshot.accounts.map((account) => account.cloudAccountId));
  const checks: QualityCheck[] = [];

  const countOk = expectedCount === undefined ? drafts.length > 0 : drafts.length === expectedCount;
  checks.push({
    name: 'count',
    passed: countOk,
    detail: expectedCount === undefined
      ? `Se obtuvieron ${drafts.length} recomendaciones.`
      : `Se esperaban ${expectedCount} y se obtuvieron ${drafts.length}.`,
  });

  checks.push(buildAllPass(
    'accountScoping',
    drafts,
    (draft) => allowedAccounts.has(draft.cloudAccountId),
    'Todas las cuentas existen en el snapshot.',
    'Hay recomendaciones con cloudAccountId inexistente en el snapshot.',
  ));

  checks.push(buildAllPass(
    'severityValid',
    drafts,
    (draft) => validSeverities.has(draft.severity),
    'Todas las severidades son válidas.',
    'Hay severidades fuera del conjunto permitido.',
  ));

  checks.push(buildAllPass(
    'evidenceLevel',
    drafts,
    (draft) => validEvidenceLevels.has(readEvidenceLevel(draft) ?? ''),
    'Todas las recomendaciones declaran un nivel de evidencia canónico.',
    'Hay recomendaciones sin nivel de evidencia válido.',
  ));

  checks.push(buildAllPass(
    'focusHonesty',
    drafts,
    (draft) => readEvidenceLevel(draft) !== 'COST_ONLY' || readRequiresTechnicalValidation(draft),
    'Las recomendaciones con solo FOCUS exigen validación técnica.',
    'Hay recomendaciones COST_ONLY que no marcan requiresTechnicalValidation.',
  ));

  checks.push(buildAllPass(
    'savingsRealism',
    drafts,
    (draft) => isSavingsRealistic(draft.estimatedMonthlySavings, snapshot.totalCost),
    'El ahorro estimado está dentro de un rango realista.',
    'Hay ahorros negativos o mayores que el costo total del periodo.',
  ));

  checks.push(buildAllPass(
    'spanishText',
    drafts,
    (draft) => draft.title.trim() !== '' && draft.description.trim() !== '',
    'Todas las recomendaciones tienen título y descripción.',
    'Hay recomendaciones sin título o descripción.',
  ));

  return toReport(checks);
}

/**
 * Evalúa un plan de ejecución ya parseado frente a la rúbrica determinista.
 *
 * Controles: arrays obligatorios no vacíos (`prerequisites`, `steps`,
 * `validation`, `risks`, `rollback`, `successCriteria`), `scope.cloudAccountId`
 * dentro del snapshot, y ausencia de promesas de ejecución automática.
 */
export function evaluateExecutionPlan(
  plan: Record<string, unknown>,
  snapshot: CostAnalyticsSnapshot,
): QualityReport {
  const allowedAccounts = new Set(snapshot.accounts.map((account) => account.cloudAccountId));
  const requiredArrays = ['prerequisites', 'steps', 'validation', 'risks', 'rollback', 'successCriteria'];
  const checks: QualityCheck[] = [];

  const arraysOk = requiredArrays.every((field) => (
    Array.isArray(plan[field]) && (plan[field] as unknown[]).length > 0
  ));
  checks.push({
    name: 'requiredArrays',
    passed: arraysOk,
    detail: arraysOk
      ? 'El plan incluye prerrequisitos, pasos, validación, riesgos, rollback y criterios.'
      : 'Faltan secciones obligatorias del plan o están vacías.',
  });

  const scope = isRecord(plan['scope']) ? plan['scope'] : {};
  const scopeAccount = typeof scope['cloudAccountId'] === 'string' ? scope['cloudAccountId'] : '';
  const scopeOk = allowedAccounts.has(scopeAccount);
  checks.push({
    name: 'scopeAccount',
    passed: scopeOk,
    detail: scopeOk ? 'El alcance apunta a una cuenta del snapshot.' : 'El alcance no referencia una cuenta válida.',
  });

  const noAuto = !containsAutoExecution(plan);
  checks.push({
    name: 'noAutoExecution',
    passed: noAuto,
    detail: noAuto ? 'El plan no promete ejecución automática.' : 'El plan promete ejecución automática (prohibido).',
  });

  return toReport(checks);
}

/** Construye un control "todos cumplen" sobre los borradores. */
function buildAllPass(
  name: string,
  drafts: readonly AiRecommendationDraft[],
  predicate: (draft: AiRecommendationDraft) => boolean,
  okDetail: string,
  failDetail: string,
): QualityCheck {
  const passed = drafts.every(predicate);
  return { name, passed, detail: passed ? okDetail : failDetail };
}

/** Lee `evidence.evidenceLevel` de forma segura. */
function readEvidenceLevel(draft: AiRecommendationDraft): string | undefined {
  if (!isRecord(draft.evidence)) {
    return undefined;
  }

  const level = draft.evidence['evidenceLevel'];
  return typeof level === 'string' ? level : undefined;
}

/** Lee `evidence.requiresTechnicalValidation === true` de forma segura. */
function readRequiresTechnicalValidation(draft: AiRecommendationDraft): boolean {
  return isRecord(draft.evidence) && draft.evidence['requiresTechnicalValidation'] === true;
}

/** Determina si un ahorro estimado es realista respecto al costo total. */
function isSavingsRealistic(savings: number | undefined, totalCost: number): boolean {
  if (savings === undefined) {
    return true;
  }

  return savings >= 0 && savings <= Math.max(totalCost, 0);
}

/** Indica si el plan contiene alguna frase de ejecución automática prohibida. */
function containsAutoExecution(plan: Record<string, unknown>): boolean {
  const haystack = JSON.stringify(plan).toLowerCase();
  return autoExecutionPhrases.some((phrase) => haystack.includes(phrase));
}

/** Agrega controles en un reporte con score 0–100. */
function toReport(checks: readonly QualityCheck[]): QualityReport {
  const passedCount = checks.filter((check) => check.passed).length;
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100);

  return {
    passed: passedCount === checks.length,
    score,
    checks,
  };
}

import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../../domain/models/FinOpsRecommendation.js';
import type { AiRecommendationDraft } from '../finOpsAiTypes.js';
import { isRecord } from '../jsonReadHelpers.js';
import type { RecommendationEvidenceSnapshot } from '../RecommendationEvidenceSnapshot.js';

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
  scopedExternalResourceId?: string,
  technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot,
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

  if (scopedExternalResourceId !== undefined) {
    checks.push(buildAllPass(
      'resourceScoping',
      drafts,
      (draft) => readExternalResourceId(draft) === scopedExternalResourceId,
      'Todas las recomendaciones apuntan al recurso solicitado.',
      'Hay recomendaciones que no apuntan exactamente al recurso solicitado.',
    ));
  }

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
    'technicalEvidenceStrength',
    drafts,
    (draft) => readEvidenceLevel(draft) !== 'COST_USAGE_AND_TECHNICAL' ||
      hasStrongTechnicalEvidence(draft, snapshot, technicalEvidenceSnapshot),
    'Las recomendaciones con evidencia tecnica tienen referencias, cobertura y frescura suficientes.',
    'Hay recomendaciones COST_USAGE_AND_TECHNICAL sin evidencia tecnica suficiente.',
  ));

  if (technicalEvidenceSnapshot !== undefined) {
    checks.push(buildAllPass(
      'canonicalTechnicalEvidence',
      drafts,
      (draft) => readEvidenceLevel(draft) !== 'COST_USAGE_AND_TECHNICAL' ||
        matchesCanonicalTechnicalEvidence(draft, technicalEvidenceSnapshot),
      'Las recomendaciones tecnicas citan exactamente el snapshot canónico.',
      'Hay recomendaciones tecnicas con recurso, referencias o reglas que no coinciden con el snapshot canonico.',
    ));
  }

  checks.push(buildAllPass(
    'technicalActionHonesty',
    drafts,
    (draft) => !isTechnicalAction(draft) || hasStrongTechnicalEvidence(draft, snapshot) || readRequiresTechnicalValidation(draft),
    'Las acciones tecnicas sin evidencia fuerte quedan marcadas para validacion.',
    'Hay acciones tecnicas presentadas sin evidencia fuerte ni validacion pendiente.',
  ));

  checks.push(buildAllPass(
    'deterministicBlockers',
    drafts,
    (draft) => readBlockers(draft).length === 0 || readRequiresTechnicalValidation(draft),
    'Las recomendaciones con bloqueos deterministas quedan como validacion tecnica.',
    'Hay recomendaciones con bloqueos deterministas presentadas como accion ejecutable.',
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

function readExternalResourceId(draft: AiRecommendationDraft): string | undefined {
  if (!isRecord(draft.evidence)) {
    return undefined;
  }

  const value = draft.evidence['externalResourceId'];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readBlockers(draft: AiRecommendationDraft): readonly string[] {
  if (!isRecord(draft.evidence)) {
    return [];
  }

  const raw = draft.evidence['blockers'];
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function hasStrongTechnicalEvidence(
  draft: AiRecommendationDraft,
  snapshot: CostAnalyticsSnapshot,
  technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot,
): boolean {
  if (!isRecord(draft.evidence)) {
    return false;
  }

  const evidenceRefs = readEvidenceRefs(draft.evidence);
  const sampleCount = readNumericEvidence(draft.evidence, 'technicalSampleCount');
  const coverageDays = readNumericEvidence(draft.evidence, 'technicalCoverageDays');
  const latestSampleAt = readStringEvidence(draft.evidence, 'latestTechnicalSampleAt');
  const hasResourceLink = readStringEvidence(draft.evidence, 'cloudResourceId') !== undefined ||
    readStringEvidence(draft.evidence, 'externalResourceId') !== undefined;

  const legacyStrong = evidenceRefs.length > 0 &&
    hasResourceLink &&
    (sampleCount >= 48 || coverageDays >= 7) &&
    isRecentTechnicalSample(latestSampleAt, snapshot);

  return technicalEvidenceSnapshot === undefined
    ? legacyStrong
    : legacyStrong && matchesCanonicalTechnicalEvidence(draft, technicalEvidenceSnapshot);
}

function matchesCanonicalTechnicalEvidence(
  draft: AiRecommendationDraft,
  snapshot: RecommendationEvidenceSnapshot,
): boolean {
  if (!isRecord(draft.evidence)) {
    return false;
  }

  const externalResourceId = readStringEvidence(draft.evidence, 'externalResourceId');
  if (externalResourceId === undefined) {
    return false;
  }

  const resource = snapshot.resources.find((item) => item.externalResourceId === externalResourceId);
  if (resource === undefined || resource.linkQuality !== 'COST_AND_TECHNICAL') {
    return false;
  }

  const refs = readEvidenceRefs(draft.evidence);
  const metricsByRef = new Map(resource.metrics.map((metric) => [metric.evidenceRef, metric]));
  const allowedRefs = new Set(metricsByRef.keys());
  const refsMatch = refs.length > 0 && refs.every((ref) => allowedRefs.has(ref));
  const ruleAllowsAction = resource.ruleEvaluation.readiness === 'GENERATABLE' &&
    resource.ruleEvaluation.blockers.length === 0;
  const referencedMetrics = refs.flatMap((ref) => {
    const metric = metricsByRef.get(ref);
    return metric === undefined ? [] : [metric];
  });
  const sampleCount = readNumericEvidence(draft.evidence, 'technicalSampleCount');
  const coverageDays = readNumericEvidence(draft.evidence, 'technicalCoverageDays');
  const latestSampleAt = readStringEvidence(draft.evidence, 'latestTechnicalSampleAt');
  const numbersMatch = referencedMetrics.length > 0 &&
    referencedMetrics.some((metric) => (
      metric.sampleCount === sampleCount &&
      metric.coverageDays === coverageDays &&
      metric.latestSampledAt === latestSampleAt
    ));
  const savingsWithinEvidence = draft.estimatedMonthlySavings === undefined || resource.cost === undefined ||
    draft.estimatedMonthlySavings <= resource.cost.totalCost * resource.ruleEvaluation.maxTechnicalSavingsRate + 0.01;

  return refsMatch && ruleAllowsAction && numbersMatch && savingsWithinEvidence;
}

function readEvidenceRefs(evidence: Record<string, unknown>): readonly string[] {
  const raw = evidence['technicalEvidenceRefs'];
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function readNumericEvidence(evidence: Record<string, unknown>, field: string): number {
  const value = evidence[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readStringEvidence(evidence: Record<string, unknown>, field: string): string | undefined {
  const value = evidence[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isRecentTechnicalSample(latestSampleAt: string | undefined, snapshot: CostAnalyticsSnapshot): boolean {
  if (latestSampleAt === undefined) {
    return false;
  }

  const latest = new Date(latestSampleAt);
  const reference = new Date(snapshot.periodEnd);
  if (Number.isNaN(latest.getTime()) || Number.isNaN(reference.getTime())) {
    return false;
  }

  const ageDays = (reference.getTime() - latest.getTime()) / (24 * 60 * 60 * 1000);
  return ageDays >= 0 && ageDays <= 7;
}

function isTechnicalAction(draft: AiRecommendationDraft): boolean {
  const text = `${draft.type} ${draft.title} ${draft.description}`.toLowerCase();
  return [
    'rightsizing',
    'rightsize',
    'redimension',
    'cpu',
    'memoria',
    'iops',
    'throughput',
    'apagar',
    'detener',
    'shutdown',
    'resize',
    'capacidad',
  ].some((keyword) => text.includes(keyword));
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

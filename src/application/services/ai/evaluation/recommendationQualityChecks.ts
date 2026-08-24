import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../../domain/models/FinOpsRecommendation.js';
import type { AiRecommendationDraft } from '../finOpsAiTypes.js';
import { isRecord } from '../jsonReadHelpers.js';
import type { RecommendationEvidenceSnapshot } from '../RecommendationEvidenceSnapshot.js';
import { collectText, looksLikeSpanish } from '../aiLanguageGuard.js';
import { buildNoSensitiveOutputCheck } from './qualitySensitiveOutput.js';
import { toReport, type QualityCheck, type QualityReport } from './qualityRubricTypes.js';

const validEvidenceLevels = new Set(['COST_ONLY', 'COST_AND_USAGE', 'COST_USAGE_AND_TECHNICAL']);
const validSeverities = new Set<FinOpsRecommendation['severity']>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

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
    (draft) => readEvidenceLevel(draft) !== 'COST_ONLY'
      || readRequiresTechnicalValidation(draft)
      || readFinancialReviewOnly(draft),
    'Las recomendaciones COST_ONLY exigen validación técnica o se identifican explícitamente como revisión financiera.',
    'Hay recomendaciones COST_ONLY sin validación técnica ni alcance financiero explícito.',
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
    'candidateSavingsCap',
    drafts,
    (draft) => isWithinCandidateSavingsCap(draft),
    'Los ahorros no superan el límite determinista del candidato.',
    'Hay un ahorro estimado superior al máximo calculado para su candidato.',
  ));

  checks.push(buildAllPass(
    'spanishText',
    drafts,
    (draft) => draft.title.trim() !== ''
      && draft.description.trim() !== ''
      && looksLikeSpanish(`${draft.title} ${draft.description}`),
    'Todas las recomendaciones tienen texto no vacío y señales de español.',
    'Hay recomendaciones vacías o redactadas sin señales suficientes de español.',
  ));

  checks.push(buildNoSensitiveOutputCheck(drafts, 'artefacto'));

  return toReport(checks);
}

/**
 * Evalúa un plan de ejecución ya parseado frente a la rúbrica determinista.
 *
 * Controles: arrays obligatorios no vacíos (`prerequisites`, `steps`,
 * `validation`, `risks`, `rollback`, `successCriteria`), `scope.cloudAccountId`
 * dentro del snapshot, y ausencia de promesas de ejecución automática.
 */

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

/** Permite revisiones FOCUS sin inventar una necesidad técnica. */
function readFinancialReviewOnly(draft: AiRecommendationDraft): boolean {
  return isRecord(draft.evidence)
    && draft.evidence['financialReviewOnly'] === true
    && draft.evidence['reviewScope'] === 'FINANCIAL'
    && draft.evidence['requiresManualValidation'] === true
    && draft.evidence['operationalAuthorization'] === 'NONE';
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
  const hasResourceLink = readStringEvidence(draft.evidence, 'cloudResourceId') !== undefined &&
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
  const cloudResourceId = readStringEvidence(draft.evidence, 'cloudResourceId');
  if (externalResourceId === undefined || cloudResourceId === undefined) {
    return false;
  }

  const matchingResources = snapshot.resources.filter((item) => item.externalResourceId === externalResourceId);
  const resource = matchingResources.length === 1
    ? matchingResources[0]
    : matchingResources.find((item) => item.cloudResourceId === cloudResourceId);
  if (
    resource === undefined
    || resource.linkQuality !== 'COST_AND_TECHNICAL'
    || resource.cloudResourceId === undefined
    || resource.cloudResourceId !== cloudResourceId
  ) {
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
  const allowedPercentages = referencedMetrics.flatMap((metric) => [
    metric.min, metric.max, metric.avg, metric.p50, metric.p95, metric.p99, metric.latest, metric.highUtilizationRatio * 100,
  ]);
  const narrativePercentagesMatch = extractPercentages(`${draft.title} ${draft.description}`)
    .every((claim) => allowedPercentages.some((value) => Math.abs(value - claim) <= 0.01));

  return refsMatch && ruleAllowsAction && numbersMatch && savingsWithinEvidence && narrativePercentagesMatch;
}

function extractPercentages(value: string): readonly number[] {
  return [...value.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)]
    .map((match) => Number.parseFloat(match[1]!.replace(',', '.')))
    .filter((number) => Number.isFinite(number));
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

function isWithinCandidateSavingsCap(draft: AiRecommendationDraft): boolean {
  if (draft.estimatedMonthlySavings === undefined || !isRecord(draft.evidence)) {
    return true;
  }

  const configuredCap = draft.evidence['maxEstimatedMonthlySavings'];
  if (typeof configuredCap !== 'number' || !Number.isFinite(configuredCap)) {
    // Golden fixtures and legacy callers may not contain the normalized cap.
    return true;
  }

  return draft.estimatedMonthlySavings >= 0 && draft.estimatedMonthlySavings <= configuredCap + 0.01;
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
  const periodEnd = new Date(snapshot.periodEnd);
  if (Number.isNaN(latest.getTime()) || Number.isNaN(periodEnd.getTime())) {
    return false;
  }

  // Monthly billing snapshots can end in the future while the technical
  // samples stop at "now". Use the earlier instant so fresh samples are not
  // rejected solely because the billing period is still open.
  const reference = new Date(Math.min(periodEnd.getTime(), Date.now()));

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

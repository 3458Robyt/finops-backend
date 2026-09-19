import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../../domain/models/FinOpsRecommendation.js';
import type { AiRecommendationDraft } from '../finOpsAiTypes.js';
import { isRecord } from '../jsonReadHelpers.js';
import type { RecommendationEvidenceSnapshot } from '../RecommendationEvidenceSnapshot.js';
import {
  getRecommendationPeriodDays,
  type RecommendationOpportunityCandidate,
  type RecommendationReadinessReport,
} from '../RecommendationReadinessGate.js';
import { collectText, looksLikeSpanish } from '../aiLanguageGuard.js';
import { buildNoSensitiveOutputCheck } from './qualitySensitiveOutput.js';
import {
  hasStrongTechnicalEvidence,
  matchesCanonicalTechnicalEvidence,
} from './recommendationTechnicalQuality.js';
import { toReport, type QualityCheck, type QualityReport } from './qualityRubricTypes.js';

const validEvidenceLevels = new Set(['COST_ONLY', 'COST_AND_USAGE', 'COST_USAGE_AND_TECHNICAL']);
const validSeverities = new Set<FinOpsRecommendation['severity']>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export function evaluateRecommendationDrafts(
  drafts: readonly AiRecommendationDraft[],
  snapshot: CostAnalyticsSnapshot,
  expectedCount?: number,
  scopedExternalResourceId?: string,
  technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot,
  readinessReport?: RecommendationReadinessReport,
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

  if (readinessReport !== undefined) {
    checks.push(buildAllPass(
      'candidateEvidenceConsistency',
      drafts,
      (draft) => matchesReadinessCandidate(draft, readinessReport.candidates, snapshot),
      'Cada recomendación coincide con el candidato y los importes autorizados.',
      'Hay recomendaciones que alteran el candidato, la evidencia financiera o el costo mensual normalizado autorizado.',
    ));
    checks.push(buildAllPass(
      'reviewScopeConsistency',
      drafts,
      (draft) => hasConsistentReviewScope(draft, readinessReport.candidates),
      'El alcance financiero y técnico coincide con el candidato autorizado.',
      'El alcance de revisión no coincide con la evidencia disponible del candidato.',
    ));
  }

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
    (draft) => isSavingsRealistic(draft.estimatedMonthlySavings, snapshot),
    'El ahorro mensual estimado está dentro del costo mensual normalizado.',
    'Hay ahorros negativos o mayores que el costo mensual normalizado.',
  ));

  checks.push(buildAllPass(
    'financialSavingsHonesty',
    drafts,
    (draft) => !readFinancialReviewOnly(draft) || draft.estimatedMonthlySavings === undefined,
    'Las revisiones financieras no contabilizan potenciales sin verificar como ahorro estimado.',
    'Hay una revisión financiera que presenta un potencial sin verificar como ahorro estimado.',
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

function matchesReadinessCandidate(
  draft: AiRecommendationDraft,
  candidates: readonly RecommendationOpportunityCandidate[],
  snapshot: CostAnalyticsSnapshot,
): boolean {
  if (!isRecord(draft.evidence)) return false;
  const candidateId = readStringEvidence(draft.evidence, 'candidateId');
  const candidate = candidateId === undefined
    ? undefined
    : candidates.find((item) => item.id === candidateId);
  if (candidate === undefined || draft.cloudAccountId !== candidate.cloudAccountId) return false;

  const externalResourceId = readExternalResourceId(draft);
  if (candidate.resourceId === undefined
    ? externalResourceId !== undefined
    : externalResourceId !== candidate.resourceId) return false;

  const cloudResourceId = readStringEvidence(draft.evidence, 'cloudResourceId');
  if (candidate.cloudResourceId === undefined
    ? cloudResourceId !== undefined
    : cloudResourceId !== candidate.cloudResourceId) return false;

  if (readEvidenceLevel(draft) !== candidate.evidenceLevelAllowed) return false;

  const observedCost = readOptionalNumericEvidence(draft.evidence, 'observedCost');
  if (candidate.observedCost !== undefined
    && (observedCost === undefined || !sameAmount(observedCost, candidate.observedCost))) return false;

  const maxSavings = readOptionalNumericEvidence(draft.evidence, 'maxEstimatedMonthlySavings');
  if (maxSavings === undefined || !sameAmount(maxSavings, candidate.maxEstimatedMonthlySavings)) return false;

  const normalizedMonthlyCost = readOptionalNumericEvidence(draft.evidence, 'normalizedMonthlyCost');
  if (candidate.observedCost !== undefined && normalizedMonthlyCost === undefined) return false;
  if (candidate.observedCost !== undefined && normalizedMonthlyCost !== undefined) {
    const expected = normalizeMonthlyAmount(candidate.observedCost, getRecommendationPeriodDays(snapshot));
    if (!sameAmount(normalizedMonthlyCost, expected)) return false;
  }

  return true;
}

function hasConsistentReviewScope(
  draft: AiRecommendationDraft,
  candidates: readonly RecommendationOpportunityCandidate[],
): boolean {
  if (!isRecord(draft.evidence)) return false;
  const candidateId = readStringEvidence(draft.evidence, 'candidateId');
  const candidate = candidateId === undefined
    ? undefined
    : candidates.find((item) => item.id === candidateId);
  if (candidate === undefined) return false;

  if (candidate.reviewScope === 'FINANCIAL') {
    return readFinancialReviewOnly(draft) && draft.estimatedMonthlySavings === undefined;
  }

  return candidate.resourceId !== undefined
    || (draft.evidence['reviewScope'] !== 'TECHNICAL' && draft.evidence['financialReviewOnly'] !== true);
}

function readOptionalNumericEvidence(evidence: Record<string, unknown>, field: string): number | undefined {
  const value = evidence[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sameAmount(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.01, Math.abs(right) * 0.001);
}

function normalizeMonthlyAmount(amount: number, periodDays: number): number {
  const normalized = amount * 30 / periodDays;
  return Math.round(normalized * 100) / 100;
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
function isSavingsRealistic(savings: number | undefined, snapshot: CostAnalyticsSnapshot): boolean {
  if (savings === undefined) {
    return true;
  }

  const monthlyCost = snapshot.totalCost * 30 / getRecommendationPeriodDays(snapshot);
  return savings >= 0 && savings <= Math.max(monthlyCost, 0);
}

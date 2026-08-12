import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type {
  RecommendationAnalysisCandidateResult,
  RecommendationAnalysisRun,
} from '../../domain/models/RecommendationAnalysisRun.js';
import type { PreparedRecommendationAnalysis } from './ai/finOpsAiTypes.js';
import type { RecommendationOpportunityCandidate } from './ai/RecommendationReadinessGate.js';
import { isRecord } from './ai/jsonReadHelpers.js';

export function buildInitialCandidateResults(prepared: PreparedRecommendationAnalysis): RecommendationAnalysisCandidateResult[] {
  return [
    ...prepared.readinessReport.candidates.map((candidate) => toCandidateResult(candidate, 'ELIGIBLE')),
    ...prepared.readinessReport.blocked.map((candidate) => toCandidateResult(candidate, 'SKIPPED')),
    ...prepared.readinessReport.deferred.map((candidate) => toCandidateResult(candidate, 'SKIPPED')),
  ];
}

export function countCandidates(prepared: PreparedRecommendationAnalysis): number {
  return prepared.readinessReport.candidates.length
    + prepared.readinessReport.blocked.length
    + prepared.readinessReport.deferred.length;
}

export function toCandidateResult(
  candidate: RecommendationOpportunityCandidate,
  outcome: RecommendationAnalysisCandidateResult['outcome'],
): RecommendationAnalysisCandidateResult {
  return {
    candidateId: candidate.id,
    ...(candidate.resourceId !== undefined ? { resourceId: candidate.resourceId } : {}),
    readiness: candidate.readiness,
    outcome,
    reasons: candidate.reasons,
  };
}

export function mergePublishedCandidates(
  initial: readonly RecommendationAnalysisCandidateResult[],
  published: readonly { readonly id: string; readonly candidateId?: string }[],
): RecommendationAnalysisCandidateResult[] {
  const byCandidate = new Map(
    published
      .filter((item): item is { id: string; candidateId: string } => item.candidateId !== undefined)
      .map((item) => [item.candidateId, item.id]),
  );
  return initial.map((candidate) => {
    if (candidate.outcome === 'SKIPPED') return candidate;
    const recommendationId = byCandidate.get(candidate.candidateId);
    return recommendationId === undefined
      ? { ...candidate, outcome: 'SKIPPED', reasons: ['El generador no publicó una recomendación para este candidato.'] }
      : { ...candidate, outcome: 'PUBLISHED', recommendationId };
  });
}

export function countResources(prepared: PreparedRecommendationAnalysis): number {
  const ids = new Set<string>();
  for (const candidate of [...prepared.readinessReport.candidates, ...prepared.readinessReport.blocked]) {
    if (candidate.resourceId !== undefined) ids.add(candidate.resourceId);
  }
  for (const resource of prepared.technicalEvidenceSnapshot?.resources ?? []) ids.add(resource.externalResourceId);
  return ids.size > 0 ? ids.size : prepared.snapshot.topResources.length;
}

export function normalizePeriod(periodStart: string, periodEnd: string): { readonly start: Date; readonly end: Date } {
  const start = new Date(periodStart);
  const parsedEnd = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(parsedEnd.getTime())) {
    throw new FinOpsBaseError('El período analítico disponible no es válido.', 'VALIDATION_ERROR');
  }
  return { start, end: parsedEnd > start ? parsedEnd : new Date(start.getTime() + 1) };
}

export function readCandidateId(evidence: unknown): string | undefined {
  if (!isRecord(evidence)) return undefined;
  const candidateId = evidence['candidateId'];
  return typeof candidateId === 'string' && candidateId.trim() !== '' ? candidateId : undefined;
}

export function isCandidate(value: unknown): value is RecommendationOpportunityCandidate {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['readiness'] === 'string'
    && Array.isArray(value['reasons']);
}

export function readNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function retryDelayMs(attempts: number): number {
  return Math.min(15_000 * Math.max(attempts, 1), 60_000);
}

export function safeMessage(error: unknown): string {
  if (error instanceof FinOpsBaseError && error.code === 'VALIDATION_ERROR') return error.message;
  return 'El análisis no pudo completarse por un fallo temporal. Se reintentará de forma controlada.';
}

export function auditCandidateResults(
  audit: Record<string, unknown>,
  reasons: readonly string[],
): RecommendationAnalysisCandidateResult[] {
  const allowed = Array.isArray(audit['candidates']) ? audit['candidates'].filter(isCandidate) : [];
  return allowed.map((candidate) => ({ ...toCandidateResult(candidate, 'REJECTED'), reasons }));
}

export function auditSummary(audit: Record<string, unknown>): Pick<RecommendationAnalysisRun, 'recommendationsGenerated' | 'promptTokenEstimate' | 'responseTokenEstimate'> {
  return {
    recommendationsGenerated: readNonNegativeInteger(audit['generatedCount']),
    promptTokenEstimate: readNonNegativeInteger(audit['promptTokenEstimate']),
    responseTokenEstimate: readNonNegativeInteger(audit['responseTokenEstimate']),
  };
}

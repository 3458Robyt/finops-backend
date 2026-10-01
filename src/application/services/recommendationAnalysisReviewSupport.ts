import type { RecommendationAnalysisCandidateAudit, RecommendationAnalysisCandidateResult, RecommendationAnalysisRun } from '../../domain/models/RecommendationAnalysisRun.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { FinOpsAiService } from './FinOpsAiService.js';
import { isRecord } from './ai/jsonReadHelpers.js';
import { readCandidateId } from './recommendationAnalysisSupport.js';

type PreparedAnalysis = Awaited<ReturnType<FinOpsAiService['prepareRecommendationAnalysis']>>;
type GeneratedReview = Awaited<ReturnType<FinOpsAiService['generateRecommendationReviewDrafts']>>;

export function buildReviewDraftCompletion(input: {
  readonly run: RecommendationAnalysisRun;
  readonly prepared: PreparedAnalysis;
  readonly generated: GeneratedReview;
  readonly initialResults: readonly RecommendationAnalysisCandidateResult[];
}): {
  readonly candidateAudits: readonly Omit<RecommendationAnalysisCandidateAudit, 'runId'>[];
  readonly candidateResults: readonly RecommendationAnalysisCandidateResult[];
  readonly status: 'COMPLETED' | 'PARTIAL' | 'SKIPPED';
  readonly errorCode?: string;
  readonly errorMessage?: string;
} {
  const candidateAudits = input.generated.candidateAudits.map(({ audit, draft, deterministicEvidence }) => ({
    tenantId: input.run.tenantId,
    candidateId: audit.candidateId ?? readCandidateId(isRecord(draft) ? draft['evidence'] : undefined) ?? `review-draft-${audit.index}`,
    draftIndex: audit.index,
    ...(deterministicEvidence === undefined ? {} : { deterministicEvidence }),
    draft,
    auditVerdict: audit.verdict,
    auditScore: audit.score,
    auditChecks: audit.checks,
    blockingIssues: audit.blockingIssues,
    requiredChanges: audit.requiredChanges,
    repairAttempt: 0,
    finalDisposition: audit.verdict === 'APPROVED' ? 'REVIEW_DRAFT' as const : 'REJECTED' as const,
    model: input.generated.model,
    auditorModel: input.generated.auditorModel,
    evidenceHash: input.prepared.evidenceHash,
  }));
  const auditsByCandidate = new Map(candidateAudits.map((audit) => [audit.candidateId, audit]));
  const selectedIds = new Set((input.prepared.readinessReport.reviewCandidates ?? []).map((candidate) => candidate.id));
  const candidateResults = input.initialResults.map((candidate) => {
    if (!selectedIds.has(candidate.candidateId)) return candidate;
    const audit = auditsByCandidate.get(candidate.candidateId);
    if (audit === undefined) {
      return { ...candidate, reasons: [...candidate.reasons, 'El generador no produjo un borrador para este recurso.'] };
    }
    return audit.finalDisposition === 'REVIEW_DRAFT'
      ? { ...candidate, outcome: 'REVIEW_DRAFT' as const, reasons: ['Borrador provisional aprobado por auditor; requiere completar evidencia técnica.'] }
      : { ...candidate, outcome: 'REJECTED' as const, reasons: audit.blockingIssues.length > 0 ? audit.blockingIssues : ['El auditor no aprobó el borrador provisional.'] };
  }).sort((left, right) => Number(selectedIds.has(right.candidateId)) - Number(selectedIds.has(left.candidateId)));
  const rejectedCount = candidateAudits.filter((audit) => audit.finalDisposition !== 'REVIEW_DRAFT').length;
  const noDrafts = input.generated.drafts.length === 0;
  return {
    candidateAudits,
    candidateResults,
    status: noDrafts ? 'SKIPPED' : rejectedCount > 0 ? 'PARTIAL' : 'COMPLETED',
    ...(noDrafts
      ? { errorCode: 'NO_REVIEW_DRAFTS', errorMessage: 'La IA no produjo borradores de revisión para los recursos elegibles; no se publicaron recomendaciones.' }
      : rejectedCount > 0
        ? { errorCode: 'REVIEW_DRAFTS_REJECTED', errorMessage: `${rejectedCount} borrador(es) fueron retenidos por auditoría; los aprobados siguen siendo solo informativos.` }
        : {}),
  };
}

export function readRejectedCandidateAudits(
  audit: Record<string, unknown>,
  run: RecommendationAnalysisRun,
): readonly Omit<RecommendationAnalysisCandidateAudit, 'runId'>[] {
  const raw = audit['candidateAudits'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value, index) => {
    if (!isRecord(value) || !isRecord(value['draft'])) return [];
    const draftIndex = typeof value['index'] === 'number' && Number.isInteger(value['index']) ? value['index'] : index;
    const candidateId = typeof value['candidateId'] === 'string' ? value['candidateId'] : readCandidateId(value['draft']['evidence']);
    const verdict = value['verdict'];
    if (candidateId === undefined || (verdict !== 'APPROVED' && verdict !== 'REJECTED' && verdict !== 'NEEDS_REVISION')) return [];
    const checks = Array.isArray(value['checks']) ? value['checks'] : [];
    const blockingIssues = Array.isArray(value['blockingIssues']) ? value['blockingIssues'].filter((item): item is string => typeof item === 'string') : [];
    const requiredChanges = Array.isArray(value['requiredChanges']) ? value['requiredChanges'].filter((item): item is string => typeof item === 'string') : [];
    return [{
      tenantId: run.tenantId, candidateId, draftIndex, draft: value['draft'],
      ...(value['deterministicEvidence'] === undefined ? {} : { deterministicEvidence: value['deterministicEvidence'] }),
      auditVerdict: verdict,
      auditScore: typeof value['score'] === 'number' ? value['score'] : 0,
      auditChecks: checks as RecommendationAnalysisCandidateAudit['auditChecks'],
      blockingIssues, requiredChanges, repairAttempt: 0, finalDisposition: 'REJECTED' as const,
      ...(typeof audit['model'] === 'string' ? { model: audit['model'] } : {}),
      ...(typeof audit['auditorModel'] === 'string' ? { auditorModel: audit['auditorModel'] } : {}),
      ...(typeof audit['evidenceHash'] === 'string' ? { evidenceHash: audit['evidenceHash'] } : {}),
    }];
  });
}

export class AnalysisStageTimer {
  private activeStage: { readonly stage: string; readonly startedAt: number } | undefined;
  private readonly durations = new Map<string, number>();

  public start(stage: string): void {
    this.finish();
    this.activeStage = { stage, startedAt: Date.now() };
  }

  public snapshot(): Readonly<Record<string, number>> {
    this.finish();
    return Object.fromEntries(this.durations);
  }

  private finish(): void {
    if (this.activeStage === undefined) return;
    const elapsed = Math.max(0, Date.now() - this.activeStage.startedAt);
    this.durations.set(this.activeStage.stage, (this.durations.get(this.activeStage.stage) ?? 0) + elapsed);
    this.activeStage = undefined;
  }
}

export class RecommendationAnalysisCancelledError extends Error {}

export class RecommendationAnalysisTimeoutError extends FinOpsBaseError {
  constructor() {
    super('El análisis superó el límite de 120 segundos y fue detenido.', 'ANALYSIS_TIMEOUT');
  }
}

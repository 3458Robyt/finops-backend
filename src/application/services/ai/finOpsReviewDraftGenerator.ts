import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { AiAuditReport, AiCandidateAuditArtifact } from '../../../domain/models/RecommendationExecutionPlan.js';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type { DeterministicTrendAnalysis } from './DeterministicTrendAnalysis.js';
import type { RecommendationReadinessReport } from './RecommendationReadinessGate.js';
import { getRecommendationPeriodDays } from './recommendationReadinessSupport.js';
import { evaluateRecommendationDrafts, type QualityReport } from './evaluation/qualityRubric.js';
import { parseRecommendationDrafts } from './finOpsAiResponseParser.js';
import type { AiRecommendationDraft } from './finOpsAiTypes.js';
import { normalizeRecommendationDrafts } from './recommendationDraftNormalizer.js';
import { FinOpsArtifactAiRunner } from './finOpsArtifactAiRunner.js';
import { selectAuditedRecommendationDrafts } from './recommendationAuditSelection.js';
import { estimateTokens } from './recommendationAiTokenEstimate.js';
import { buildDeterministicRejectionReport } from './recommendationAuditReports.js';

export interface AuditedDraftsResult {
  readonly drafts: readonly (AiRecommendationDraft & { tenantId: string })[];
  readonly approvedDrafts: readonly (AiRecommendationDraft & { tenantId: string })[];
  readonly rejectedDrafts: readonly (AiRecommendationDraft & { tenantId: string })[];
  readonly candidateAudits: readonly AiCandidateAuditArtifact[];
  readonly auditReport?: AiAuditReport;
  readonly firstRawResponse: string;
  readonly promptTokenEstimate?: number;
  readonly responseTokenEstimate?: number;
}

export async function generateAuditedReviewDrafts(input: {
  readonly runner: FinOpsArtifactAiRunner;
  readonly tenantId: string;
  readonly userId?: string;
  readonly snapshot: CostAnalyticsSnapshot;
  readonly systemPrompt: string;
  readonly readinessReport: RecommendationReadinessReport;
  readonly technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot;
  readonly deterministicAnalysis?: DeterministicTrendAnalysis;
  readonly deadlineAt?: number;
  readonly onAuditStart?: () => Promise<void> | void;
  readonly combineQuality: (audit: AiAuditReport, quality: QualityReport) => AiAuditReport;
}): Promise<AuditedDraftsResult> {
  const firstRawResponse = await input.runner.generateReviewDrafts(input.systemPrompt, input.deadlineAt);
  const reviewCandidates = input.readinessReport.reviewCandidates?.length
    ? input.readinessReport.reviewCandidates
    : input.readinessReport.candidates;
  const reviewReadiness = {
    ...input.readinessReport,
    candidates: reviewCandidates,
  };
  const allowedIds = new Set(reviewReadiness.candidates.map((candidate) => candidate.id));
  const selected = parseRecommendationDrafts(firstRawResponse, input.snapshot)
    .filter((draft) => {
      const evidence = draft.evidence as Record<string, unknown>;
      return typeof evidence['candidateId'] === 'string' && allowedIds.has(evidence['candidateId']);
    }).slice(0, 5);
  const drafts = normalizeRecommendationDrafts(
    selected, reviewReadiness, input.technicalEvidenceSnapshot, undefined,
    getRecommendationPeriodDays(input.snapshot),
    { preserveValidationNarrative: true, candidatePool: reviewReadiness.candidates },
  ).map((draft) => ({ tenantId: input.tenantId, ...draft }));

  if (drafts.length === 0) {
    return {
      drafts: [], approvedDrafts: [], rejectedDrafts: [], candidateAudits: [], firstRawResponse,
      promptTokenEstimate: estimateTokens(input.systemPrompt),
      responseTokenEstimate: estimateTokens(firstRawResponse),
    };
  }

  const quality = evaluateRecommendationDrafts(
    drafts, input.snapshot, undefined, undefined, input.technicalEvidenceSnapshot, reviewReadiness,
  );
  if (quality.passed) await input.onAuditStart?.();
  const auditReport = quality.passed
    ? await input.runner.auditArtifact({
        artifactType: 'recommendations', snapshot: input.snapshot, tenantId: input.tenantId,
        ...(input.userId === undefined ? {} : { userId: input.userId }), artifact: drafts,
        ...(input.technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot: input.technicalEvidenceSnapshot }),
        ...(input.deterministicAnalysis === undefined ? {} : { deterministicAnalysis: input.deterministicAnalysis }),
        readinessReport: reviewReadiness,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      })
    : buildDeterministicRejectionReport(quality);
  const combinedAudit = input.combineQuality(auditReport, quality);
  const selection = selectAuditedRecommendationDrafts({
    drafts, auditReport: combinedAudit, snapshot: input.snapshot,
    ...(input.technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot: input.technicalEvidenceSnapshot }),
    readinessReport: reviewReadiness,
  });

  return {
    drafts,
    approvedDrafts: selection.accepted.map((draft) => ({ tenantId: input.tenantId, ...draft })),
    rejectedDrafts: selection.rejected.map((draft) => ({ tenantId: input.tenantId, ...draft })),
    candidateAudits: selection.candidateAudits.map((audit) => ({
      audit, draft: drafts[audit.index], deterministicEvidence: drafts[audit.index]?.evidence,
    })),
    auditReport: { ...combinedAudit, candidateAudits: selection.candidateAudits },
    firstRawResponse,
    promptTokenEstimate: estimateTokens(input.systemPrompt),
    responseTokenEstimate: estimateTokens(firstRawResponse),
  };
}

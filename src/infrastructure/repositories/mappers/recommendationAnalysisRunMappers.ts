import type { RecommendationAnalysisCandidateAudit, RecommendationAnalysisCandidateResult, RecommendationAnalysisRun } from '../../../domain/models/RecommendationAnalysisRun.js';
import type { Prisma } from '../../../generated/prisma/client.js';

export const runInclude = {
  recommendationLinks: {
    include: {
      recommendation: {
        select: { title: true },
      },
    },
  },
} as const;

export const runDetailInclude = {
  ...runInclude,
  candidateAudits: {
    orderBy: { draftIndex: 'asc' as const },
  },
} as const;

export type RunRow = Prisma.RecommendationAnalysisRunGetPayload<{ include: typeof runInclude }>;
export type RunDetailRow = Prisma.RecommendationAnalysisRunGetPayload<{ include: typeof runDetailInclude }>;

export function toRecommendationAnalysisRunDomain(row: RunRow | RunDetailRow): RecommendationAnalysisRun {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ...(row.requestedByUserId !== null ? { requestedByUserId: row.requestedByUserId } : {}),
    ...(row.retriedFromRunId !== null ? { retriedFromRunId: row.retriedFromRunId } : {}),
    trigger: row.trigger,
    scope: row.scope,
    scopeKey: row.scopeKey,
    ...(row.externalResourceId !== null ? { externalResourceId: row.externalResourceId } : {}),
    ...(row.cloudResourceId !== null ? { cloudResourceId: row.cloudResourceId } : {}),
    status: row.status,
    stage: row.stage,
    ...(row.periodStart !== null ? { periodStart: row.periodStart } : {}),
    ...(row.periodEnd !== null ? { periodEnd: row.periodEnd } : {}),
    ...(row.evidenceHash !== null ? { evidenceHash: row.evidenceHash } : {}),
    ...(row.snapshot !== null ? { snapshot: row.snapshot } : {}),
    ...(row.evidenceSnapshot !== null ? { evidenceSnapshot: row.evidenceSnapshot } : {}),
    ...(row.readinessReport !== null ? { readinessReport: row.readinessReport } : {}),
    ...(row.candidateResults !== null
      ? { candidateResults: row.candidateResults as unknown as RecommendationAnalysisCandidateResult[] }
      : {}),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    resourcesEvaluated: row.resourcesEvaluated,
    candidatesFound: row.candidatesFound,
    candidatesSkipped: row.candidatesSkipped,
    recommendationsGenerated: row.recommendationsGenerated,
    recommendationsRejected: row.recommendationsRejected,
    recommendationsPersisted: row.recommendationsPersisted,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.auditorModel !== null ? { auditorModel: row.auditorModel } : {}),
    promptTokenEstimate: row.promptTokenEstimate,
    responseTokenEstimate: row.responseTokenEstimate,
    ...(row.latencyMs !== null ? { latencyMs: row.latencyMs } : {}),
    ...(row.workerId !== null ? { workerId: row.workerId } : {}),
    ...(row.errorCode !== null ? { errorCode: row.errorCode } : {}),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    recommendations: row.recommendationLinks.map((link) => ({
      recommendationId: link.recommendationId,
      ...(link.candidateId !== null ? { candidateId: link.candidateId } : {}),
      disposition: link.disposition,
      title: link.recommendation.title,
    })),
    ...('candidateAudits' in row ? { candidateAudits: row.candidateAudits.map(toCandidateAuditDomain) } : {}),
  };
}

function toCandidateAuditDomain(row: RunDetailRow['candidateAudits'][number]): RecommendationAnalysisCandidateAudit {
  return {
    tenantId: row.tenantId,
    runId: row.runId,
    candidateId: row.candidateId,
    draftIndex: row.draftIndex,
    ...(row.recommendationId === null ? {} : { recommendationId: row.recommendationId }),
    ...(row.deterministicEvidence === null ? {} : { deterministicEvidence: row.deterministicEvidence }),
    ...(row.draft === null ? {} : { draft: row.draft }),
    auditVerdict: row.auditVerdict,
    auditScore: row.auditScore,
    auditChecks: row.auditChecks as unknown as RecommendationAnalysisCandidateAudit['auditChecks'],
    blockingIssues: row.blockingIssues as unknown as RecommendationAnalysisCandidateAudit['blockingIssues'],
    requiredChanges: row.requiredChanges as unknown as RecommendationAnalysisCandidateAudit['requiredChanges'],
    repairAttempt: row.repairAttempt,
    finalDisposition: row.finalDisposition,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.auditorModel === null ? {} : { auditorModel: row.auditorModel }),
    ...(row.promptHash === null ? {} : { promptHash: row.promptHash }),
    ...(row.evidenceHash === null ? {} : { evidenceHash: row.evidenceHash }),
  };
}

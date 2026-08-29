import type {
  RecommendationAnalysisCandidateAudit,
  RecommendationAnalysisCandidateResult,
  RecommendationAnalysisRecommendationDisposition,
  RecommendationAnalysisRun,
  RecommendationAnalysisRunStage,
  RecommendationAnalysisRunStatus,
  RecommendationAnalysisScope,
  RecommendationAnalysisTrigger,
} from '../models/RecommendationAnalysisRun.js';

export interface QueueRecommendationAnalysisRunInput {
  readonly tenantId: string;
  readonly requestedByUserId?: string;
  readonly trigger: RecommendationAnalysisTrigger;
  readonly scope: RecommendationAnalysisScope;
  readonly externalResourceId?: string;
  readonly cloudResourceId?: string;
  readonly retriedFromRunId?: string;
  readonly maxAttempts?: number;
}

export interface ClaimedRecommendationAnalysisRun extends RecommendationAnalysisRun {
  readonly workerId: string;
}

export interface PreparedRecommendationAnalysisRunInput {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly evidenceHash: string;
  readonly snapshot: unknown;
  readonly evidenceSnapshot?: unknown;
  readonly readinessReport: unknown;
  readonly resourcesEvaluated: number;
  readonly candidatesFound: number;
  readonly candidatesSkipped: number;
  readonly candidateResults: readonly RecommendationAnalysisCandidateResult[];
  readonly model: string;
  readonly auditorModel: string;
}

export interface CompleteRecommendationAnalysisRunInput {
  readonly status: Extract<RecommendationAnalysisRunStatus, 'COMPLETED' | 'PARTIAL' | 'SKIPPED'>;
  readonly recommendationsGenerated: number;
  readonly recommendationsRejected: number;
  readonly candidateResults: readonly RecommendationAnalysisCandidateResult[];
  readonly recommendationLinks: readonly {
    readonly recommendationId: string;
    readonly candidateId?: string;
    readonly disposition: RecommendationAnalysisRecommendationDisposition;
  }[];
  readonly candidateAudits?: readonly Omit<RecommendationAnalysisCandidateAudit, 'runId'>[];
  readonly promptTokenEstimate: number;
  readonly responseTokenEstimate: number;
  readonly latencyMs: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface IRecommendationAnalysisRunRepository {
  queue(input: QueueRecommendationAnalysisRunInput): Promise<{ readonly run: RecommendationAnalysisRun; readonly reused: boolean }>;
  findById(tenantId: string, runId: string): Promise<RecommendationAnalysisRun | null>;
  listByTenant(tenantId: string, limit?: number): Promise<RecommendationAnalysisRun[]>;
  cancelPending(tenantId: string, runId: string): Promise<RecommendationAnalysisRun | null>;
  retryFailed(tenantId: string, runId: string, requestedByUserId: string): Promise<RecommendationAnalysisRun | null>;
  claimNext(workerId: string, staleBefore: Date): Promise<ClaimedRecommendationAnalysisRun | null>;
  updateStage(runId: string, stage: RecommendationAnalysisRunStage): Promise<void>;
  savePrepared(runId: string, input: PreparedRecommendationAnalysisRunInput): Promise<void>;
  findEquivalentCompleted(
    tenantId: string,
    scopeKey: string,
    periodStart: Date,
    periodEnd: Date,
    evidenceHash: string,
    excludeRunId: string,
  ): Promise<RecommendationAnalysisRun | null>;
  complete(runId: string, input: CompleteRecommendationAnalysisRunInput): Promise<RecommendationAnalysisRun>;
  recordFailure(
    runId: string,
    input: { readonly code: string; readonly message: string; readonly retryAt: Date },
  ): Promise<RecommendationAnalysisRun>;
}

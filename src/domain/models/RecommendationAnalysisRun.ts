export type RecommendationAnalysisRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'SKIPPED'
  | 'FAILED'
  | 'CANCELLED';

export type RecommendationAnalysisRunStage =
  | 'QUEUED'
  | 'SELECTING_DATA'
  | 'DETERMINISTIC_ANALYSIS'
  | 'EVIDENCE_GATE'
  | 'AI_GENERATION'
  | 'AI_AUDIT'
  | 'PERSISTENCE'
  | 'NOTIFICATION'
  | 'FINISHED';

export type RecommendationAnalysisTrigger = 'MANUAL' | 'SCHEDULED' | 'POST_INGESTION' | 'RETRY';
export type RecommendationAnalysisScope = 'TENANT' | 'RESOURCE';
export type RecommendationAnalysisRecommendationDisposition = 'CREATED' | 'REUSED';

export interface RecommendationAnalysisCandidateResult {
  readonly candidateId: string;
  readonly resourceId?: string;
  readonly readiness: string;
  readonly outcome: 'ELIGIBLE' | 'SKIPPED' | 'PUBLISHED' | 'REJECTED';
  readonly reasons: readonly string[];
  readonly recommendationId?: string;
}

export interface RecommendationAnalysisRecommendationLink {
  readonly recommendationId: string;
  readonly candidateId?: string;
  readonly disposition: RecommendationAnalysisRecommendationDisposition;
  readonly title: string;
}

export interface RecommendationAnalysisRun {
  readonly id: string;
  readonly tenantId: string;
  readonly requestedByUserId?: string;
  readonly retriedFromRunId?: string;
  readonly trigger: RecommendationAnalysisTrigger;
  readonly scope: RecommendationAnalysisScope;
  readonly scopeKey: string;
  readonly externalResourceId?: string;
  readonly cloudResourceId?: string;
  readonly status: RecommendationAnalysisRunStatus;
  readonly stage: RecommendationAnalysisRunStage;
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly evidenceHash?: string;
  readonly snapshot?: unknown;
  readonly evidenceSnapshot?: unknown;
  readonly readinessReport?: unknown;
  readonly candidateResults?: readonly RecommendationAnalysisCandidateResult[];
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly resourcesEvaluated: number;
  readonly candidatesFound: number;
  readonly candidatesSkipped: number;
  readonly recommendationsGenerated: number;
  readonly recommendationsRejected: number;
  readonly recommendationsPersisted: number;
  readonly model?: string;
  readonly auditorModel?: string;
  readonly promptTokenEstimate: number;
  readonly responseTokenEstimate: number;
  readonly latencyMs?: number;
  readonly workerId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly recommendations: readonly RecommendationAnalysisRecommendationLink[];
}

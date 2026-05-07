import type { FinOpsRecommendation } from '../models/FinOpsRecommendation.js';
import type { RecommendationFeedbackReason } from '../models/AgentLearning.js';
import type {
  AiAuditReport,
  AiAuditVerdict,
  RecommendationExecutionPlan,
} from '../models/RecommendationExecutionPlan.js';

export interface RecommendationQuery {
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly status?: FinOpsRecommendation['status'];
}

export interface CreateRecommendationInput {
  readonly tenantId: string;
  readonly cloudAccountId: string;
  readonly type: string;
  readonly severity: FinOpsRecommendation['severity'];
  readonly title: string;
  readonly description: string;
  readonly evidence: unknown;
  readonly estimatedMonthlySavings?: number;
  readonly currency: string;
}

export interface CreateRecommendationExecutionPlanInput {
  readonly recommendationId: string;
  readonly generatedByUserId: string;
  readonly model: string;
  readonly auditorModel: string;
  readonly content: unknown;
  readonly auditReport: AiAuditReport;
  readonly auditVerdict: AiAuditVerdict;
  readonly auditScore: number;
}

export interface CreateRecommendationDecisionInput {
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly executionPlanId?: string;
  readonly userId: string;
  readonly decision: 'APPROVED' | 'REJECTED' | 'MARKED_DONE';
  readonly reasonCode?: RecommendationFeedbackReason;
  readonly reason?: string;
}

export interface CreateRecommendationDecisionResult {
  readonly decisionId: string;
  readonly recommendation: FinOpsRecommendation;
}

export type ManualExecutionStatus = 'PLANNED' | 'EXECUTED' | 'PARTIAL' | 'CANCELLED';

export interface RecommendationManualExecution {
  readonly id: string;
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly executionPlanId?: string;
  readonly userId: string;
  readonly status: ManualExecutionStatus;
  readonly executedAt?: Date;
  readonly observedMonthlySavings?: number;
  readonly currency: string;
  readonly notes?: string;
  readonly evidence?: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateManualExecutionInput {
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly executionPlanId?: string;
  readonly userId: string;
  readonly status: ManualExecutionStatus;
  readonly executedAt?: Date;
  readonly observedMonthlySavings?: number;
  readonly currency: string;
  readonly notes?: string;
  readonly evidence?: unknown;
}

export interface RecommendationTimelineEvent {
  readonly id: string;
  readonly type: 'RECOMMENDATION_CREATED' | 'PLAN_GENERATED' | 'DECISION_RECORDED' | 'MANUAL_EXECUTION_RECORDED' | 'LEARNING_EVENT';
  readonly title: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly metadata?: unknown;
}

export interface SavingsKpis {
  readonly estimatedMonthlySavings: number;
  readonly observedMonthlySavings: number;
  readonly confirmedMonthlySavings: number;
  readonly currency: string;
  readonly executedRecommendations: number;
}

export interface AdoptionKpis {
  readonly totalRecommendations: number;
  readonly pendingRecommendations: number;
  readonly approvedRecommendations: number;
  readonly rejectedRecommendations: number;
  readonly completedRecommendations: number;
  readonly acceptanceRate: number;
  readonly rejectionRate: number;
  readonly executionRate: number;
}

export interface IRecommendationRepository {
  findByTenant(query: RecommendationQuery): Promise<FinOpsRecommendation[]>;
  findById(tenantId: string, recommendationId: string): Promise<FinOpsRecommendation | null>;
  createMany(input: readonly CreateRecommendationInput[]): Promise<FinOpsRecommendation[]>;
  createExecutionPlan(input: CreateRecommendationExecutionPlanInput): Promise<RecommendationExecutionPlan>;
  findExecutionPlanById(
    tenantId: string,
    executionPlanId: string,
  ): Promise<RecommendationExecutionPlan | null>;
  findLatestExecutionPlanByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationExecutionPlan | null>;
  createDecision(input: CreateRecommendationDecisionInput): Promise<CreateRecommendationDecisionResult>;
  createManualExecution(input: CreateManualExecutionInput): Promise<RecommendationManualExecution>;
  findManualExecutionsByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationManualExecution[]>;
  findTimelineByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationTimelineEvent[]>;
  getSavingsKpis(tenantId: string): Promise<SavingsKpis>;
  getAdoptionKpis(tenantId: string): Promise<AdoptionKpis>;
}

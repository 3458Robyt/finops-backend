export type RecommendationFeedbackReason =
  | 'APPROVED_HIGH_CONFIDENCE'
  | 'APPROVED_LOW_RISK_QUICK_WIN'
  | 'REJECTED_INSUFFICIENT_EVIDENCE'
  | 'REJECTED_SAVINGS_UNREALISTIC'
  | 'REJECTED_OPERATIONAL_RISK'
  | 'REJECTED_BUSINESS_EXCEPTION'
  | 'REJECTED_ALREADY_HANDLED'
  | 'REJECTED_WRONG_SCOPE'
  | 'REJECTED_NOT_ACTIONABLE';

export type AgentLearningStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'ERROR';

export type AgentMemoryScope = 'LOCAL' | 'GLOBAL';

export type AgentMemoryType =
  | 'RULE'
  | 'LESSON'
  | 'APPROVAL_PATTERN'
  | 'REJECTION_PATTERN'
  | 'DECISION_PATTERN';

export interface AgentLearningEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly decisionId: string;
  readonly status: AgentLearningStatus;
  readonly auditVerdict?: string;
  readonly auditScore?: number;
  readonly createdAt: Date;
}

export interface AgentMemory {
  readonly id: string;
  readonly tenantId?: string;
  readonly scope: AgentMemoryScope;
  readonly memoryType: AgentMemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly active: boolean;
  readonly createdAt: Date;
}

export type AiAuditVerdict = 'APPROVED' | 'REJECTED' | 'NEEDS_REVISION';

export interface AiAuditCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly notes: string;
}

export interface AiAuditReport {
  readonly verdict: AiAuditVerdict;
  readonly score: number;
  readonly checks: readonly AiAuditCheck[];
  readonly blockingIssues: readonly string[];
  readonly requiredChanges: readonly string[];
}

export interface RecommendationExecutionPlan {
  readonly id: string;
  readonly recommendationId: string;
  readonly generatedByUserId: string;
  readonly model: string;
  readonly auditorModel: string;
  readonly content: unknown;
  readonly auditReport: unknown;
  readonly auditVerdict: AiAuditVerdict;
  readonly auditScore: number;
  readonly createdAt: Date;
}

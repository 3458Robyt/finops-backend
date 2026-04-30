export interface FinOpsRecommendation {
  readonly id: string;
  readonly cloudAccountId: string;
  readonly type: string;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MANUAL_COMPLETED';
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly title: string;
  readonly description: string;
  readonly evidence: unknown;
  readonly estimatedMonthlySavings?: number;
  readonly currency: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

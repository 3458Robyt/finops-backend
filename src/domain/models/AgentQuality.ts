/** A bounded report of recommendation quality and AI operating cost. */
export interface AgentQualityMetric {
  readonly generated: number;
  readonly reviewed: number;
  readonly approved: number;
  readonly rejected: number;
  readonly markedDone: number;
  readonly reviewRate: number | null;
  readonly approvalRate: number | null;
  readonly rejectionRate: number | null;
  readonly abstained: number;
  readonly insufficientEvidence: number;
  readonly verified: number;
  readonly estimatedSavings: number;
  readonly verifiedSavings: number;
  readonly estimatedVsVerifiedErrorPercent: number | null;
  readonly verifiedOutcomeRate: number | null;
}

export interface AgentQualityDimensionMetric extends AgentQualityMetric {
  readonly dimension: 'TYPE' | 'RULE' | 'PROVIDER';
  readonly key: string;
}

export interface AgentQualityTraceMetrics {
  readonly calls: number;
  readonly successfulCalls: number;
  readonly failedCalls: number;
  readonly successRate: number | null;
  readonly averageLatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly promptTokens: number;
  readonly responseTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number | null;
  readonly costEstimateAvailable: boolean;
}

export interface AgentQualityReport {
  readonly generatedAt: Date;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly totals: AgentQualityMetric;
  readonly dimensions: readonly AgentQualityDimensionMetric[];
  readonly traces: AgentQualityTraceMetrics;
  /** Clarifies that approval is a quality proxy, not ML ground-truth precision. */
  readonly notes: readonly string[];
}

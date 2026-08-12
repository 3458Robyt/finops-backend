import type { AgentQualityReport } from '../models/AgentQuality.js';

export interface AgentQualityReportQuery {
  readonly tenantId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export interface AgentQualityRecommendationRow {
  readonly id: string;
  readonly type: string;
  readonly provider?: string | null;
  readonly estimatedMonthlySavings?: number | null;
  readonly decision?: 'APPROVED' | 'REJECTED' | 'MARKED_DONE' | null;
  readonly observedSavings?: number | null;
  readonly evidence?: unknown;
}

export interface AgentQualityTraceRow {
  readonly operation: string;
  readonly status: string;
  readonly latencyMs?: number;
  readonly promptTokenEstimate: number;
  readonly responseTokenEstimate?: number;
}

export interface IAgentQualityRepository {
  listRecommendationRows(query: AgentQualityReportQuery): Promise<readonly AgentQualityRecommendationRow[]>;
  listTraceRows(query: AgentQualityReportQuery): Promise<readonly AgentQualityTraceRow[]>;
}

export type AgentQualityReportResult = AgentQualityReport;

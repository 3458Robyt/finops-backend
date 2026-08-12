import type { AgentQualityReport } from '../models/AgentQuality.js';

export interface AgentQualityReportQuery {
  readonly tenantId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

export interface AgentQualityPageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface AgentQualityPageQuery {
  readonly limit: number;
  readonly cursor?: AgentQualityPageCursor;
}

export interface AgentQualityPage<T> {
  readonly rows: readonly T[];
  readonly nextCursor?: AgentQualityPageCursor;
}

export interface AgentQualityRecommendationRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly type: string;
  readonly provider?: string | null;
  readonly estimatedMonthlySavings?: number | null;
  readonly decision?: 'APPROVED' | 'REJECTED' | 'MARKED_DONE' | null;
  readonly observedSavings?: number | null;
  readonly evidence?: unknown;
}

export interface AgentQualityTraceRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly operation: string;
  readonly status: string;
  readonly latencyMs?: number;
  readonly promptTokenEstimate: number;
  readonly responseTokenEstimate?: number;
}

export interface IAgentQualityRepository {
  listRecommendationRows(
    query: AgentQualityReportQuery,
    page: AgentQualityPageQuery,
  ): Promise<AgentQualityPage<AgentQualityRecommendationRow>>;
  listTraceRows(
    query: AgentQualityReportQuery,
    page: AgentQualityPageQuery,
  ): Promise<AgentQualityPage<AgentQualityTraceRow>>;
}

export type AgentQualityReportResult = AgentQualityReport;

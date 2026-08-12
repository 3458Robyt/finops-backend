import type {
  AgentQualityRecommendationRow,
  AgentQualityReportQuery,
  AgentQualityTraceRow,
} from '../../../domain/interfaces/IAgentQualityRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

/** Reads only the fields needed for the bounded quality report. */
export async function listQualityRecommendationRows(
  prisma: PrismaClient,
  query: AgentQualityReportQuery,
): Promise<readonly AgentQualityRecommendationRow[]> {
  return prisma.$queryRaw<readonly AgentQualityRecommendationRow[]>`
    WITH latest_decision AS (
      SELECT DISTINCT ON (recommendation_id)
        recommendation_id,
        decision::text AS decision
      FROM recommendation_decisions
      WHERE created_at < ${query.periodEnd}
      ORDER BY recommendation_id, created_at DESC, id DESC
    ), latest_verified AS (
      SELECT DISTINCT ON (recommendation_id)
        recommendation_id,
        observed_savings::double precision AS observed_savings
      FROM recommendation_savings_measurements
      WHERE tenant_id = ${query.tenantId}
        AND status = 'VERIFIED'::"SavingsMeasurementStatus"
        AND created_at < ${query.periodEnd}
      ORDER BY recommendation_id, verified_at DESC NULLS LAST, created_at DESC, id DESC
    )
    SELECT
      r.id,
      r.type,
      ca.provider::text AS provider,
      r.estimated_monthly_savings::double precision AS "estimatedMonthlySavings",
      ld.decision,
      lv.observed_savings AS "observedSavings",
      r.evidence
    FROM recommendations r
    LEFT JOIN cloud_accounts ca ON ca.id = r.cloud_account_id
    LEFT JOIN latest_decision ld ON ld.recommendation_id = r.id
    LEFT JOIN latest_verified lv ON lv.recommendation_id = r.id
    WHERE r.tenant_id = ${query.tenantId}
      AND r.created_at >= ${query.periodStart}
      AND r.created_at < ${query.periodEnd}
    ORDER BY r.created_at DESC
  `;
}

export async function listQualityTraceRows(
  prisma: PrismaClient,
  query: AgentQualityReportQuery,
): Promise<readonly AgentQualityTraceRow[]> {
  return prisma.$queryRaw<readonly AgentQualityTraceRow[]>`
    SELECT
      operation::text AS operation,
      status,
      latency_ms AS "latencyMs",
      prompt_token_estimate AS "promptTokenEstimate",
      response_token_estimate AS "responseTokenEstimate"
    FROM ai_context_traces
    WHERE tenant_id = ${query.tenantId}
      AND created_at >= ${query.periodStart}
      AND created_at < ${query.periodEnd}
    ORDER BY created_at DESC
  `;
}

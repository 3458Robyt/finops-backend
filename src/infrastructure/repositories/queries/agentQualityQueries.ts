import type {
  AgentQualityPage,
  AgentQualityPageQuery,
  AgentQualityPageCursor,
  AgentQualityRecommendationRow,
  AgentQualityReportQuery,
  AgentQualityTraceRow,
} from '../../../domain/interfaces/IAgentQualityRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { Prisma } from '../../../generated/prisma/client.js';

const MAX_QUALITY_PAGE_SIZE = 1_000;

function normalizePageSize(page: AgentQualityPageQuery): number {
  const requested = Number.isFinite(page.limit) ? Math.trunc(page.limit) : 1;
  return Math.min(Math.max(requested, 1), MAX_QUALITY_PAGE_SIZE);
}

function buildCursorCondition(
  cursor: AgentQualityPageCursor | undefined,
  alias: string,
): Prisma.Sql {
  if (cursor === undefined) return Prisma.empty;
  if (alias === 'r') return Prisma.sql`AND (r.created_at, r.id) < (${cursor.createdAt}, ${cursor.id})`;
  return Prisma.sql`AND (trace.created_at, trace.id) < (${cursor.createdAt}, ${cursor.id})`;
}

function buildNextCursor<T extends { readonly createdAt: Date; readonly id: string }>(
  rows: readonly T[],
  pageSize: number,
): AgentQualityPageCursor | undefined {
  if (rows.length <= pageSize) return undefined;
  const last = rows[pageSize - 1];
  if (last === undefined) return undefined;
  return { createdAt: last.createdAt, id: last.id };
}

/** Reads only the fields needed for the bounded quality report. */
export async function listQualityRecommendationRows(
  prisma: PrismaClient,
  query: AgentQualityReportQuery,
  page: AgentQualityPageQuery,
): Promise<AgentQualityPage<AgentQualityRecommendationRow>> {
  const pageSize = normalizePageSize(page);
  const cursorCondition = buildCursorCondition(page.cursor, 'r');
  const rows = await prisma.$queryRaw<AgentQualityRecommendationRow[]>(Prisma.sql`
    SELECT
      r.id,
      r.created_at AS "createdAt",
      r.type,
      ca.provider::text AS provider,
      r.estimated_monthly_savings::double precision AS "estimatedMonthlySavings",
      (
        SELECT rd.decision::text
        FROM recommendation_decisions rd
        WHERE rd.recommendation_id = r.id
          AND rd.created_at < ${query.periodEnd}
        ORDER BY rd.created_at DESC, rd.id DESC
        LIMIT 1
      ) AS decision,
      (
        SELECT rsm.observed_savings::double precision
        FROM recommendation_savings_measurements rsm
        WHERE rsm.recommendation_id = r.id
          AND rsm.tenant_id = ${query.tenantId}
          AND rsm.status = 'VERIFIED'::"SavingsMeasurementStatus"
          AND rsm.created_at < ${query.periodEnd}
        ORDER BY rsm.verified_at DESC NULLS LAST, rsm.created_at DESC, rsm.id DESC
        LIMIT 1
      ) AS "observedSavings",
      r.evidence
    FROM recommendations r
    LEFT JOIN cloud_accounts ca ON ca.id = r.cloud_account_id
    WHERE r.tenant_id = ${query.tenantId}
      AND r.created_at >= ${query.periodStart}
      AND r.created_at < ${query.periodEnd}
      ${cursorCondition}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${pageSize + 1}
  `);

  const hasMore = rows.length > pageSize;
  const visibleRows = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = buildNextCursor(rows, pageSize);
  if (nextCursor === undefined) return { rows: visibleRows };
  return {
    rows: visibleRows,
    nextCursor,
  };
}

export async function listQualityTraceRows(
  prisma: PrismaClient,
  query: AgentQualityReportQuery,
  page: AgentQualityPageQuery,
): Promise<AgentQualityPage<AgentQualityTraceRow>> {
  const pageSize = normalizePageSize(page);
  const cursorCondition = buildCursorCondition(page.cursor, 'trace');
  const rows = await prisma.$queryRaw<AgentQualityTraceRow[]>(Prisma.sql`
    SELECT
      trace.id,
      trace.created_at AS "createdAt",
      operation::text AS operation,
      status,
      latency_ms AS "latencyMs",
      prompt_token_estimate AS "promptTokenEstimate",
      response_token_estimate AS "responseTokenEstimate"
    FROM ai_context_traces trace
    WHERE trace.tenant_id = ${query.tenantId}
      AND trace.created_at >= ${query.periodStart}
      AND trace.created_at < ${query.periodEnd}
      ${cursorCondition}
    ORDER BY trace.created_at DESC, trace.id DESC
    LIMIT ${pageSize + 1}
  `);

  const hasMore = rows.length > pageSize;
  const visibleRows = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = buildNextCursor(rows, pageSize);
  if (nextCursor === undefined) return { rows: visibleRows };
  return {
    rows: visibleRows,
    nextCursor,
  };
}

import type { PrismaClient } from '../../../generated/prisma/client.js';

/** Fila agregada devuelta por la consulta de observabilidad del aprendizaje. */
export interface LearningSummaryStatsRow {
  readonly total_events: number;
  readonly feedback_approved: number;
  readonly feedback_rejected: number;
  readonly learning_pending: number;
  readonly learning_approved: number;
  readonly learning_rejected: number;
  readonly learning_skipped: number;
  readonly learning_error: number;
}

/**
 * Cuenta feedback y estados del auditor en una sola consulta acotada al tenant.
 *
 * Los casts a integer evitan transportar `bigint` desde PostgreSQL al contrato
 * HTTP y los filtros SQL evitan cargar eventos completos solo para contar.
 */
export async function queryLearningSummaryStats(
  prisma: PrismaClient,
  tenantId: string,
): Promise<LearningSummaryStatsRow> {
  const rows = await prisma.$queryRaw<readonly LearningSummaryStatsRow[]>`
    SELECT
      COUNT(*)::int AS total_events,
      COUNT(*) FILTER (WHERE decision = 'APPROVED')::int AS feedback_approved,
      COUNT(*) FILTER (WHERE decision = 'REJECTED')::int AS feedback_rejected,
      COUNT(*) FILTER (WHERE status = 'PENDING')::int AS learning_pending,
      COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS learning_approved,
      COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS learning_rejected,
      COUNT(*) FILTER (WHERE status = 'SKIPPED')::int AS learning_skipped,
      COUNT(*) FILTER (WHERE status = 'ERROR')::int AS learning_error
    FROM agent_learning_events
    WHERE tenant_id = ${tenantId}
  `;

  return rows[0] ?? {
    total_events: 0,
    feedback_approved: 0,
    feedback_rejected: 0,
    learning_pending: 0,
    learning_approved: 0,
    learning_rejected: 0,
    learning_skipped: 0,
    learning_error: 0,
  };
}

import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

const LEASE_RECOVERY_HISTORY_LIMIT = 10;

export interface IngestionJobReconciliationResult {
  readonly requeued: number;
  readonly failed: number;
  readonly cancelled: number;
}

/** Recovers jobs left RUNNING after a worker/process interruption. */
export class PrismaIngestionJobLeaseReconciler {
  public async reconcile(
    prisma: PrismaClient,
    jobLeaseMs: number,
    now = new Date(),
  ): Promise<IngestionJobReconciliationResult> {
    return prisma.$transaction((tx) => this.reconcileInTransaction(tx, jobLeaseMs, now));
  }

  public async reconcileInTransaction(
    tx: Prisma.TransactionClient,
    jobLeaseMs: number,
    now: Date,
  ): Promise<IngestionJobReconciliationResult> {
    const leaseExpiredBefore = new Date(now.getTime() - Math.max(1_000, jobLeaseMs));
    const cancelled = await tx.$executeRaw`
      UPDATE ingestion_jobs
      SET status = 'CANCELLED',
          completed_at = ${now},
          error_message = 'Cancelado mientras el trabajo estaba bloqueado.',
          locked_at = NULL,
          locked_by = NULL,
          result_summary = COALESCE(result_summary, '{}'::jsonb) || jsonb_build_object(
            'leaseRecoveryHistory', ${buildLeaseRecoveryHistorySql(now, jobLeaseMs, 'CANCELLED', 'cancel_requested_while_lease_expired')}
          ),
          progress = jsonb_build_object(
            'phase', 'CANCELLED',
            'message', 'Cancelado tras expirar el bloqueo.',
            'updatedAt', CAST(${now.toISOString()} AS text)
          )
      WHERE status = 'RUNNING'
        AND locked_at IS NOT NULL
        AND locked_at < ${leaseExpiredBefore}
        AND cancel_requested_at IS NOT NULL
    `;
    const failed = await tx.$executeRaw`
      UPDATE ingestion_jobs
      SET status = 'FAILED',
          completed_at = ${now},
          error_message = 'El bloqueo del trabajo venció tras agotar los intentos; la causa inicial no quedó registrada.',
          locked_at = NULL,
          locked_by = NULL,
          result_summary = COALESCE(result_summary, '{}'::jsonb) || jsonb_build_object(
            'leaseRecoveryHistory', ${buildLeaseRecoveryHistorySql(now, jobLeaseMs, 'FAILED', 'retry_attempts_exhausted')}
          ),
          progress = jsonb_build_object(
            'phase', 'FAILED',
            'message', 'Trabajo agotó sus intentos después de expirar el bloqueo.',
            'updatedAt', CAST(${now.toISOString()} AS text)
          )
      WHERE status = 'RUNNING'
        AND locked_at IS NOT NULL
        AND locked_at < ${leaseExpiredBefore}
        AND cancel_requested_at IS NULL
        AND attempts >= max_attempts
    `;
    const requeued = await tx.$executeRaw`
      UPDATE ingestion_jobs
      SET status = 'PENDING',
          available_at = ${now},
          completed_at = NULL,
          error_message = 'Trabajo recuperado después de expirar el bloqueo; se reintentará.',
          locked_at = NULL,
          locked_by = NULL,
          result_summary = COALESCE(result_summary, '{}'::jsonb) || jsonb_build_object(
            'leaseRecoveryHistory', ${buildLeaseRecoveryHistorySql(now, jobLeaseMs, 'REQUEUED', 'lease_expired_with_attempts_available')}
          ),
          progress = jsonb_build_object(
            'phase', 'RETRY_WAIT',
            'message', 'Trabajo recuperado y listo para reintento.',
            'updatedAt', CAST(${now.toISOString()} AS text)
          )
      WHERE status = 'RUNNING'
        AND locked_at IS NOT NULL
        AND locked_at < ${leaseExpiredBefore}
        AND cancel_requested_at IS NULL
        AND attempts < max_attempts
    `;

    return {
      requeued: Number(requeued),
      failed: Number(failed),
      cancelled: Number(cancelled),
    };
  }
}

function buildLeaseRecoveryHistorySql(
  now: Date,
  jobLeaseMs: number,
  action: 'CANCELLED' | 'FAILED' | 'REQUEUED',
  reason: string,
): Prisma.Sql {
  const previousHistory = Prisma.sql`
    CASE
      WHEN jsonb_typeof(result_summary -> 'leaseRecoveryHistory') = 'array'
        THEN result_summary -> 'leaseRecoveryHistory'
      ELSE '[]'::jsonb
    END
  `;
  const historyWithCurrentEvent = Prisma.sql`
    ${previousHistory} || jsonb_build_array(jsonb_build_object(
      'action', CAST(${action} AS text),
      'recoveredAt', CAST(${now.toISOString()} AS text),
      'reason', CAST(${reason} AS text),
      'attempt', attempts,
      'maxAttempts', max_attempts,
      'leaseDurationMs', CAST(${jobLeaseMs} AS integer),
      'attemptStartedAt', started_at,
      'lastHeartbeatAt', locked_at,
      'leaseExpiredAt', locked_at + (CAST(${jobLeaseMs} AS integer) * INTERVAL '1 millisecond'),
      'lastProgress', progress
    ))
  `;
  return Prisma.sql`(
    SELECT COALESCE(jsonb_agg(recovery.event ORDER BY recovery.ordinal), '[]'::jsonb)
    FROM jsonb_array_elements(${historyWithCurrentEvent}) WITH ORDINALITY AS recovery(event, ordinal)
    WHERE recovery.ordinal > GREATEST(
      jsonb_array_length(${previousHistory}) + 1 - CAST(${LEASE_RECOVERY_HISTORY_LIMIT} AS integer),
      0
    )
  )`;
}

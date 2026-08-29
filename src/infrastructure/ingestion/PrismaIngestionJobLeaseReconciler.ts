import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

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
          error_message = 'Ingestion job lease expired after exhausting retry attempts',
          locked_at = NULL,
          locked_by = NULL,
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

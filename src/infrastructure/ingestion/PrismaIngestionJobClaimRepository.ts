import type { CloudIngestionJobContext } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaIngestionJobSupport } from './PrismaIngestionJobSupport.js';

interface ClaimedJobRow {
  readonly id: string;
}

/** Claims one queued ingestion job while fencing stale workers. */
export class PrismaIngestionJobClaimRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly support: PrismaIngestionJobSupport,
    private readonly jobLeaseMs: number,
  ) {}

  public async claimNextPendingJob(workerId: string): Promise<CloudIngestionJobContext | null> {
    const now = new Date();
    const leaseExpiredBefore = new Date(now.getTime() - this.jobLeaseMs);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE ingestion_jobs
        SET status = 'FAILED',
            completed_at = ${now},
            error_message = 'Ingestion job lease expired after exhausting retry attempts',
            locked_at = NULL,
            locked_by = NULL
        WHERE status = 'RUNNING'
          AND locked_at < ${leaseExpiredBefore}
          AND attempts >= max_attempts
      `;
      await tx.$executeRaw`
        UPDATE ingestion_jobs
        SET status = 'CANCELLED',
            completed_at = ${now},
            error_message = 'Cancelado mientras el trabajo estaba bloqueado.',
            locked_at = NULL,
            locked_by = NULL,
            progress = jsonb_build_object('phase', 'CANCELLED', 'message', 'Cancelado tras expirar el bloqueo.', 'updatedAt', CAST(${now.toISOString()} AS text))
        WHERE status = 'RUNNING'
          AND cancel_requested_at IS NOT NULL
          AND locked_at < ${leaseExpiredBefore}
      `;
      const rows = await tx.$queryRaw<ClaimedJobRow[]>`
        SELECT id
        FROM ingestion_jobs
        WHERE attempts < max_attempts
          AND available_at <= ${now}
          AND cancel_requested_at IS NULL
          AND archived_at IS NULL
          AND (
            status = 'PENDING'
            OR (status = 'RUNNING' AND locked_at < ${leaseExpiredBefore})
          )
        -- Technical backfills are consumed oldest-first so a newly requeued
        -- historical gap cannot wait behind newer jobs created earlier.
        ORDER BY priority ASC,
          CASE WHEN source_type = 'TECHNICAL_METRIC'::"IngestionSourceType" THEN target_start ELSE created_at END ASC,
          created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;

      const claimed = rows[0];
      if (claimed === undefined) return null;

      await tx.ingestionJob.update({
        where: { id: claimed.id },
        data: {
          status: 'RUNNING',
          attempts: { increment: 1 },
          lockedAt: now,
          lockedBy: workerId,
          startedAt: now,
          errorMessage: null,
          progress: { phase: 'DISCOVERING', message: 'Trabajo tomado por el worker.', updatedAt: now.toISOString() },
        },
      });

      const job = await this.support.findJobContext(claimed.id, tx);
      return job === null ? null : this.support.toJobContext(job);
    });
  }
}

import type { CloudIngestionJobContext } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaIngestionJobSupport } from './PrismaIngestionJobSupport.js';
import { PrismaIngestionJobLeaseReconciler } from './PrismaIngestionJobLeaseReconciler.js';
import type { IngestionJobReconciliationResult } from './PrismaIngestionJobLeaseReconciler.js';

interface ClaimedJobRow {
  readonly id: string;
}

/** Claims one queued ingestion job while fencing stale workers. */
export class PrismaIngestionJobClaimRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly support: PrismaIngestionJobSupport,
    private readonly jobLeaseMs: number,
    private readonly leaseReconciler = new PrismaIngestionJobLeaseReconciler(),
  ) {}

  /** Requeues recoverable stale jobs and closes exhausted/cancelled leases. */
  public reconcileStaleJobs(now = new Date()): Promise<IngestionJobReconciliationResult> {
    return this.leaseReconciler.reconcile(this.prisma, this.jobLeaseMs, now);
  }

  public async claimNextPendingJob(workerId: string): Promise<CloudIngestionJobContext | null> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.leaseReconciler.reconcileInTransaction(tx, this.jobLeaseMs, now);
      const rows = await tx.$queryRaw<ClaimedJobRow[]>`
        SELECT id
        FROM ingestion_jobs
        WHERE attempts < max_attempts
          AND available_at <= ${now}
          AND cancel_requested_at IS NULL
          AND archived_at IS NULL
          AND status = 'PENDING'
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

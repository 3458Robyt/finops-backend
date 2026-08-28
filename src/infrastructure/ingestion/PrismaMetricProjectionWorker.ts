import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { safeErrorMessage, safeErrorName } from '../../application/observability/safeError.js';
import type { MetricsRegistry } from '../../application/observability/MetricsRegistry.js';
import { runWithDatabaseContext } from '../database/tenantContext.js';
import { PrismaMetricStreamSummaryPersistence } from './PrismaMetricStreamSummaryPersistence.js';
import { PrismaMetricCoveragePersistence } from './PrismaMetricCoveragePersistence.js';
import { PrismaResourceMetricRollupPersistence } from '../repositories/PrismaResourceMetricRollupPersistence.js';

interface ProjectionQueueRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly cloud_connection_id: string;
  readonly projection_attempts: number;
  readonly projection_max_attempts: number;
}

interface ClaimedProjection {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface MetricProjectionWorkerRunResult {
  readonly processed: boolean;
  readonly jobId?: string;
  readonly status?: 'SUCCESS' | 'PENDING' | 'FAILED';
  readonly errorMessage?: string;
}

export interface MetricProjectionWorkerOptions {
  readonly leaseMs?: number;
  readonly retryBackoffMs?: number;
  readonly transactionTimeoutMs?: number;
}

/**
 * Builds technical summaries and rollups after raw ingestion has completed.
 * Projection failures never change the raw ingestion outcome, so a slow or
 * unavailable database projection cannot make a provider job appear stuck.
 */
export class PrismaMetricProjectionWorker {
  private readonly streamSummaries = new PrismaMetricStreamSummaryPersistence();
  private readonly coverage = new PrismaMetricCoveragePersistence();
  private readonly rollups = new PrismaResourceMetricRollupPersistence();
  private readonly leaseMs: number;
  private readonly retryBackoffMs: number;
  private readonly transactionTimeoutMs: number;

  public constructor(
    private readonly prisma: PrismaClient,
    private readonly metrics?: MetricsRegistry,
    options: MetricProjectionWorkerOptions = {},
  ) {
    this.leaseMs = positiveOrDefault(options.leaseMs, 300_000);
    this.retryBackoffMs = positiveOrDefault(options.retryBackoffMs, 5_000);
    this.transactionTimeoutMs = positiveOrDefault(options.transactionTimeoutMs, 120_000);
  }

  public async processNext(workerId: string): Promise<MetricProjectionWorkerRunResult> {
    const claimed = await runWithDatabaseContext(
      { workerId, role: 'MASTER_ADMIN' },
      () => this.claimNext(workerId),
    );
    if (claimed === null) return { processed: false };

    return runWithDatabaseContext(
      { tenantId: claimed.tenantId, workerId, role: 'MASTER_ADMIN' },
      () => this.project(claimed, workerId),
    );
  }

  private async claimNext(workerId: string): Promise<ClaimedProjection | null> {
    const now = new Date();
    const leaseExpiredBefore = new Date(now.getTime() - this.leaseMs);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "ingestion_jobs"
        SET "projection_status" = CASE
              WHEN "projection_attempts" >= "projection_max_attempts"
                THEN 'FAILED'::"MetricProjectionStatus"
              ELSE 'PENDING'::"MetricProjectionStatus"
            END,
            "projection_available_at" = CASE
              WHEN "projection_attempts" >= "projection_max_attempts" THEN NULL
              ELSE CURRENT_TIMESTAMP
            END,
            "projection_locked_at" = NULL,
            "projection_locked_by" = NULL,
            "projection_error_message" = CASE
              WHEN "projection_attempts" >= "projection_max_attempts"
                THEN 'La proyección técnica agotó sus intentos después de expirar el lease.'
              ELSE "projection_error_message"
            END,
            "progress" = CASE
              WHEN "projection_attempts" >= "projection_max_attempts" THEN
                jsonb_build_object(
                  'phase', 'FAILED',
                  'message', 'Los datos raw están disponibles, pero la proyección técnica agotó sus intentos.',
                  'projectionStatus', 'FAILED',
                  'updatedAt', CURRENT_TIMESTAMP::text
                )
              ELSE "progress"
            END
        WHERE "status" = 'SUCCESS'::"IngestionJobStatus"
          AND "source_type" = 'TECHNICAL_METRIC'::"IngestionSourceType"
          AND "projection_status" = 'RUNNING'::"MetricProjectionStatus"
          AND "projection_locked_at" < ${leaseExpiredBefore}
      `;

      const rows = await tx.$queryRaw<ProjectionQueueRow[]>`
        SELECT
          job."id",
          job."tenant_id",
          job."cloud_connection_id",
          job."projection_attempts",
          job."projection_max_attempts"
        FROM "ingestion_jobs" job
        WHERE job."status" = 'SUCCESS'::"IngestionJobStatus"
          AND job."source_type" = 'TECHNICAL_METRIC'::"IngestionSourceType"
          AND job."projection_status" = 'PENDING'::"MetricProjectionStatus"
          AND job."archived_at" IS NULL
          AND (job."projection_available_at" IS NULL OR job."projection_available_at" <= ${now})
          AND job."projection_attempts" < job."projection_max_attempts"
          AND NOT EXISTS (
            SELECT 1
            FROM "ingestion_jobs" running
            WHERE running."status" = 'SUCCESS'::"IngestionJobStatus"
              AND running."source_type" = 'TECHNICAL_METRIC'::"IngestionSourceType"
              AND running."cloud_connection_id" = job."cloud_connection_id"
              AND running."projection_status" = 'RUNNING'::"MetricProjectionStatus"
          )
          -- Only one projection transaction per connection may be claimed.
          AND pg_try_advisory_xact_lock(
            hashtextextended('finops:metric-projection:' || job."cloud_connection_id", 0)
          )
        ORDER BY job."projection_available_at" NULLS FIRST,
          job."completed_at" ASC NULLS LAST,
          job."created_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;

      const nextAttempt = Number(row.projection_attempts) + 1;
      const updated = await tx.ingestionJob.updateMany({
        where: {
          id: row.id,
          status: 'SUCCESS',
          projectionStatus: 'PENDING',
          projectionAttempts: Number(row.projection_attempts),
        },
        data: {
          projectionStatus: 'RUNNING',
          projectionAttempts: nextAttempt,
          projectionAvailableAt: null,
          projectionLockedAt: now,
          projectionLockedBy: workerId,
          projectionStartedAt: now,
          projectionCompletedAt: null,
          projectionErrorMessage: null,
          progress: {
            phase: 'PROJECTING',
            message: 'Datos raw persistidos; construyendo proyecciones técnicas.',
            projectionStatus: 'RUNNING',
            updatedAt: now.toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      if (updated.count !== 1) return null;

      return {
        id: row.id,
        tenantId: row.tenant_id,
        cloudConnectionId: row.cloud_connection_id,
        attempt: nextAttempt,
        maxAttempts: Number(row.projection_max_attempts),
      };
    });
  }

  private async project(claimed: ClaimedProjection, workerId: string): Promise<MetricProjectionWorkerRunResult> {
    const startedAt = Date.now();
    try {
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        await this.streamSummaries.refreshMetricStreamSummariesForJob(tx, claimed.id, now);
        await this.rollups.refreshForJob(tx, claimed.id);
        await this.coverage.refreshForJob(tx, claimed.id, now);

        const completed = await tx.ingestionJob.updateMany({
          where: {
            id: claimed.id,
            status: 'SUCCESS',
            projectionStatus: 'RUNNING',
            projectionLockedBy: workerId,
            projectionAttempts: claimed.attempt,
          },
          data: {
            projectionStatus: 'SUCCESS',
            projectionAvailableAt: null,
            projectionLockedAt: null,
            projectionLockedBy: null,
            projectionCompletedAt: now,
            projectionErrorMessage: null,
            progress: {
              phase: 'COMPLETED',
              message: 'Ingesta raw y proyección técnica completadas correctamente.',
              projectionStatus: 'SUCCESS',
              updatedAt: now.toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
        });
        if (completed.count !== 1) throw new Error('La proyección perdió el lease antes de completar.');
      }, { maxWait: 10_000, timeout: this.transactionTimeoutMs });

      this.metrics?.increment('metric_projection_runs_total', { outcome: 'success' });
      this.metrics?.observe('metric_projection_duration_ms', Date.now() - startedAt, { outcome: 'success' });
      return { processed: true, jobId: claimed.id, status: 'SUCCESS' };
    } catch (error) {
      const message = safeErrorMessage(error);
      console.error(JSON.stringify({
        level: 'error',
        event: 'metric_projection_failed',
        jobId: claimed.id,
        cloudConnectionId: claimed.cloudConnectionId,
        attempt: claimed.attempt,
        errorName: safeErrorName(error),
        error: message,
      }));
      const retryScheduled = claimed.attempt < claimed.maxAttempts;
      const availableAt = retryScheduled
        ? new Date(Date.now() + this.retryBackoffMs * 2 ** Math.min(claimed.attempt - 1, 6))
        : undefined;
      await this.prisma.ingestionJob.updateMany({
        where: {
          id: claimed.id,
          status: 'SUCCESS',
          projectionStatus: 'RUNNING',
          projectionLockedBy: workerId,
          projectionAttempts: claimed.attempt,
        },
        data: {
          projectionStatus: retryScheduled ? 'PENDING' : 'FAILED',
          projectionAvailableAt: availableAt ?? null,
          projectionLockedAt: null,
          projectionLockedBy: null,
          projectionErrorMessage: message,
          progress: {
            phase: retryScheduled ? 'RAW_COMPLETE' : 'FAILED',
            message: retryScheduled
              ? 'Datos raw disponibles; la proyección falló y se reintentará automáticamente.'
              : 'Datos raw disponibles, pero la proyección técnica agotó sus intentos.',
            projectionStatus: retryScheduled ? 'PENDING' : 'FAILED',
            projectionError: message,
            ...(availableAt === undefined ? {} : { nextProjectionAttemptAt: availableAt.toISOString() }),
            updatedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      this.metrics?.increment('metric_projection_runs_total', { outcome: retryScheduled ? 'retry' : 'failed' });
      this.metrics?.observe('metric_projection_duration_ms', Date.now() - startedAt, { outcome: retryScheduled ? 'retry' : 'failed' });
      return {
        processed: true,
        jobId: claimed.id,
        status: retryScheduled ? 'PENDING' : 'FAILED',
        errorMessage: message,
      };
    }
  }
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

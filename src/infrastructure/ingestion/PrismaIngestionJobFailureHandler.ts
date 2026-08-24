import type { CloudIngestionJobContext } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { safeErrorMessage } from '../../application/observability/safeError.js';

export class PrismaIngestionJobFailureHandler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly retryBackoffMs: number,
  ) {}

  public async failJob(
    job: CloudIngestionJobContext,
    error: unknown,
    startedAt: Date,
    workerId: string,
  ): Promise<void> {
    const completedAt = new Date();
    const message = safeErrorMessage(error);
    const current = await this.prisma.ingestionJob.findFirst({
      where: { id: job.id, status: 'RUNNING', lockedBy: workerId, attempts: job.attempt },
      select: { attempts: true, maxAttempts: true },
    });
    const shouldRetry = current !== null && current.attempts < current.maxAttempts;

    const nextRetryAt = shouldRetry
      ? new Date(completedAt.getTime() + this.retryBackoffMs * 2 ** Math.min(job.attempt - 1, 6))
      : undefined;
    const failed = await this.prisma.ingestionJob.updateMany({
      where: { id: job.id, status: 'RUNNING', lockedBy: workerId, attempts: job.attempt },
      data: {
        status: shouldRetry ? 'PENDING' : 'FAILED',
        ...(nextRetryAt !== undefined ? { availableAt: nextRetryAt } : {}),
        completedAt,
        lockedAt: null,
        lockedBy: null,
        errorMessage: message,
        resultSummary: {
          durationMs: completedAt.getTime() - startedAt.getTime(),
          providerCode: job.connection.providerCode,
          sourceType: job.sourceType,
          error: message,
          retryScheduled: shouldRetry,
          ...(nextRetryAt !== undefined ? { nextRetryAt: nextRetryAt.toISOString() } : {}),
        } as unknown as Prisma.InputJsonValue,
        progress: {
          phase: shouldRetry ? 'RETRY_WAIT' : 'FAILED',
          message: shouldRetry ? 'Reintento programado con backoff.' : 'Trabajo agotó sus intentos.',
          updatedAt: completedAt.toISOString(),
          ...(nextRetryAt !== undefined ? { nextRetryAt: nextRetryAt.toISOString() } : {}),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    if (failed.count !== 1) return;

    await this.prisma.dataQualityCheck.create({
      data: {
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        sourceType: job.sourceType,
        checkName: 'ingestion_job_execution',
        status: shouldRetry ? 'WARNING' : 'FAILED',
        expectedAt: job.targetEnd,
        details: {
          jobId: job.id,
          error: message,
          retryScheduled: shouldRetry,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }
}

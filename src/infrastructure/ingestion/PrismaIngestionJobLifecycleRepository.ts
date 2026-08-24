import type { CloudIngestionJobContext } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

export interface IngestionJobProgress {
  readonly phase: 'QUEUED' | 'DISCOVERING' | 'FETCHING' | 'NORMALIZING' | 'PERSISTING' | 'FINALIZING' | 'RETRY_WAIT' | 'COMPLETED' | 'CANCELLED' | 'CANCELLATION_REQUESTED' | 'FAILED';
  readonly message?: string;
  readonly completed?: number;
  readonly total?: number;
  readonly unit?: string;
  readonly providerCalls?: number;
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
  readonly resources?: number;
  readonly samples?: number;
  readonly updatedAt: string;
}

/** Persists progress and cooperative cancellation without mixing it into job claim/completion logic. */
export class PrismaIngestionJobLifecycleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async updateJobProgress(jobId: string, workerId: string, attempt: number, progress: IngestionJobProgress): Promise<boolean> {
    const updated = await this.prisma.ingestionJob.updateMany({
      where: { id: jobId, status: 'RUNNING', lockedBy: workerId, attempts: attempt },
      data: { progress: progress as unknown as Prisma.InputJsonValue },
    });
    return updated.count === 1;
  }

  public async isCancellationRequested(jobId: string, workerId: string, attempt: number): Promise<boolean> {
    const job = await this.prisma.ingestionJob.findFirst({
      where: { id: jobId, status: 'RUNNING', lockedBy: workerId, attempts: attempt },
      select: { cancelRequestedAt: true },
    });
    return job?.cancelRequestedAt != null;
  }

  public async markCancelled(job: CloudIngestionJobContext, workerId: string, message = 'Cancelado por el usuario.'): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.ingestionJob.updateMany({
      where: { id: job.id, status: 'RUNNING', lockedBy: workerId, attempts: job.attempt },
      data: {
        status: 'CANCELLED',
        completedAt: now,
        lockedAt: null,
        lockedBy: null,
        errorMessage: message,
        progress: { phase: 'CANCELLED', message, updatedAt: now.toISOString() } as unknown as Prisma.InputJsonValue,
      },
    });
    return updated.count === 1;
  }
}

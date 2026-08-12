import type {
  CreateIngestionJobInput,
  IngestionJobSummary,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type { IngestionSourceType } from '../../domain/models/CloudConnection.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

/** Encapsulates idempotent creation of ingestion jobs. */
export class PrismaCloudIngestionCommandRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async createIngestionJob(input: CreateIngestionJobInput): Promise<IngestionJobSummary> {
    try {
      return toIngestionJobSummary(await this.prisma.ingestionJob.create({
        data: {
          tenantId: input.tenantId,
          cloudConnectionId: input.cloudConnectionId,
          sourceType: input.sourceType,
          targetStart: input.targetStart,
          targetEnd: input.targetEnd,
          ...(input.requestedByUserId !== undefined ? { requestedByUserId: input.requestedByUserId } : {}),
          ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
        },
      }));
    } catch (error: unknown) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const existing = await this.prisma.ingestionJob.findFirst({
        where: {
          tenantId: input.tenantId,
          cloudConnectionId: input.cloudConnectionId,
          sourceType: input.sourceType,
          targetStart: input.targetStart,
          targetEnd: input.targetEnd,
          status: { in: ['PENDING', 'RUNNING'] },
        },
      });
      if (existing === null) throw error;
      return toIngestionJobSummary(existing);
    }
  }
}

function toIngestionJobSummary(job: {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly status: IngestionJobSummary['status'];
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): IngestionJobSummary {
  return {
    id: job.id,
    tenantId: job.tenantId,
    cloudConnectionId: job.cloudConnectionId,
    sourceType: job.sourceType,
    status: job.status,
    targetStart: job.targetStart,
    targetEnd: job.targetEnd,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

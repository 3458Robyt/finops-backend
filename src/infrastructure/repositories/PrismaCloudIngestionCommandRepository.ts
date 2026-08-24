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
          priority: input.priority ?? defaultPriority(input.sourceType),
          progress: {
            phase: 'QUEUED',
            message: 'Trabajo encolado; esperando un slot del worker.',
            updatedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
          ...(input.configurationHash !== undefined ? { configurationHash: input.configurationHash } : {}),
          ...(input.requestContext !== undefined ? { requestContext: input.requestContext as Prisma.InputJsonValue } : {}),
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
          ...(input.configurationHash !== undefined ? { configurationHash: input.configurationHash } : {}),
          status: { in: ['PENDING', 'RUNNING'] },
        },
      });
      if (existing === null) throw error;
      return toIngestionJobSummary(existing);
    }
  }
}

function defaultPriority(sourceType: IngestionSourceType): number {
  switch (sourceType) {
    case 'INVENTORY': return 10;
    case 'BILLING_EXPORT': return 20;
    case 'TECHNICAL_METRIC': return 30;
    case 'AGENT_METRIC': return 40;
  }
}

function toIngestionJobSummary(job: {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly status: IngestionJobSummary['status'];
  readonly dataOutcome: IngestionJobSummary['dataOutcome'] | null;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly configurationHash: string | null;
  readonly requestContext: unknown;
}): IngestionJobSummary {
  return {
    id: job.id,
    tenantId: job.tenantId,
    cloudConnectionId: job.cloudConnectionId,
    sourceType: job.sourceType,
    status: job.status,
    ...(job.dataOutcome !== null && job.dataOutcome !== undefined ? { dataOutcome: job.dataOutcome } : {}),
    targetStart: job.targetStart,
    targetEnd: job.targetEnd,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.configurationHash !== null ? { configurationHash: job.configurationHash } : {}),
    ...(isJsonObject(job.requestContext) ? { requestContext: job.requestContext } : {}),
  };
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

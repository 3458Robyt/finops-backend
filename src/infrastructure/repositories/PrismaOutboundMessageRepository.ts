import type {
  CreateOutboundMessageDeliveryInput,
  IOutboundMessageRepository,
  ListOutboundMessageDeliveriesInput,
} from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { OutboundMessageDelivery } from '../../domain/models/OutboundMessage.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

export class PrismaOutboundMessageRepository implements IOutboundMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async create(input: CreateOutboundMessageDeliveryInput): Promise<OutboundMessageDelivery> {
    const row = await this.prisma.outboundMessageDelivery.create({
      data: {
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        ...(input.recommendationId !== undefined ? { recommendationId: input.recommendationId } : {}),
        channel: input.channel,
        messageType: input.messageType,
        status: input.status ?? 'PENDING',
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        preview: input.preview,
        body: input.body ?? input.preview,
        ...(input.providerMessageId !== undefined ? { providerMessageId: input.providerMessageId } : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
        ...(input.maxAttempts !== undefined ? { maxAttempts: Math.max(1, Math.min(input.maxAttempts, 10)) } : {}),
      },
    });

    return toOutboundDelivery(row);
  }

  public async listRecent(input: ListOutboundMessageDeliveriesInput): Promise<readonly OutboundMessageDelivery[]> {
    const rows = await this.prisma.outboundMessageDelivery.findMany({
      where: { tenantId: input.tenantId },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(input.limit, 100)),
    });

    return rows.map(toOutboundDelivery);
  }

  public async findByDedupeKey(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly channel: OutboundMessageDelivery['channel'];
    readonly messageType: OutboundMessageDelivery['messageType'];
    readonly dedupeKey: string;
  }): Promise<OutboundMessageDelivery | null> {
    const row = await this.prisma.outboundMessageDelivery.findFirst({
      where: {
        tenantId: input.tenantId,
        userId: input.userId,
        channel: input.channel,
        messageType: input.messageType,
        metadata: { path: ['dedupeKey'], equals: input.dedupeKey },
      },
      orderBy: { createdAt: 'desc' },
    });
    return row === null ? null : toOutboundDelivery(row);
  }

  public async claimNextPending(input: {
    readonly workerId: string;
    readonly leaseExpiredBefore: Date;
  }): Promise<{
    readonly delivery: OutboundMessageDelivery;
    readonly body: string;
    readonly attempts: number;
    readonly maxAttempts: number;
  } | null> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "outbound_message_deliveries"
        SET "status" = 'FAILED',
            "error_message" = 'La entrega agotó sus intentos después de una interrupción.',
            "locked_at" = NULL,
            "locked_by" = NULL,
            "updated_at" = NOW()
        WHERE "status" = 'PROCESSING'
          AND ("locked_at" IS NULL OR "locked_at" < ${input.leaseExpiredBefore})
          AND "attempt_count" >= "max_attempts"
      `;
      await tx.$executeRaw`
        UPDATE "outbound_message_deliveries"
        SET "status" = 'PENDING',
            "locked_at" = NULL,
            "locked_by" = NULL,
            "next_attempt_at" = NOW(),
            "updated_at" = NOW()
        WHERE "status" = 'PROCESSING'
          AND ("locked_at" IS NULL OR "locked_at" < ${input.leaseExpiredBefore})
          AND "attempt_count" < "max_attempts"
      `;

      const candidates = await tx.$queryRaw<readonly { readonly id: string }[]>`
        SELECT "id"
        FROM "outbound_message_deliveries"
        WHERE "status" = 'PENDING'
          AND "next_attempt_at" <= ${now}
          AND "attempt_count" < "max_attempts"
        ORDER BY "next_attempt_at" ASC, "created_at" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const candidate = candidates[0];
      if (candidate === undefined) return null;

      const row = await tx.outboundMessageDelivery.update({
        where: { id: candidate.id },
        data: {
          status: 'PROCESSING',
          attemptCount: { increment: 1 },
          lockedAt: now,
          lockedBy: input.workerId,
        },
      });
      return {
        delivery: toOutboundDelivery(row),
        body: row.body,
        attempts: row.attemptCount,
        maxAttempts: row.maxAttempts,
      };
    });
  }

  public async completeClaimed(input: {
    readonly id: string;
    readonly workerId: string;
    readonly status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
    readonly errorMessage?: string;
    readonly providerMessageId?: string;
    readonly nextAttemptAt?: Date;
  }): Promise<OutboundMessageDelivery | null> {
    const updated = await this.prisma.outboundMessageDelivery.updateMany({
      where: { id: input.id, status: 'PROCESSING', lockedBy: input.workerId },
      data: {
        status: input.status,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: input.nextAttemptAt ?? new Date(),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.providerMessageId !== undefined ? { providerMessageId: input.providerMessageId } : {}),
        ...(input.status === 'SENT' ? { sentAt: new Date(), errorMessage: null } : {}),
      },
    });
    if (updated.count === 0) return null;
    const row = await this.prisma.outboundMessageDelivery.findUnique({ where: { id: input.id } });
    return row === null ? null : toOutboundDelivery(row);
  }

  public async findTenantUsers(tenantId: string): Promise<readonly { readonly id: string; readonly email: string; readonly name: string; readonly status: 'ACTIVE' | 'DISABLED' }[]> {
    return this.prisma.user.findMany({
      where: {
        OR: [
          { tenantId },
          { tenantAccessAssignments: { some: { tenantId, disabledAt: null } } },
        ],
      },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
      },
      orderBy: { email: 'asc' },
    });
  }
}

function toOutboundDelivery(row: {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly recommendationId: string | null;
  readonly channel: OutboundMessageDelivery['channel'];
  readonly messageType: OutboundMessageDelivery['messageType'];
  readonly status: OutboundMessageDelivery['status'];
  readonly subject: string | null;
  readonly preview: string;
  readonly body: string;
  readonly providerMessageId: string | null;
  readonly errorMessage: string | null;
  readonly metadata: unknown;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): OutboundMessageDelivery {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ...(row.userId !== null ? { userId: row.userId } : {}),
    ...(row.recommendationId !== null ? { recommendationId: row.recommendationId } : {}),
    channel: row.channel,
    messageType: row.messageType,
    status: row.status,
    ...(row.subject !== null ? { subject: row.subject } : {}),
    preview: row.preview,
    ...(row.providerMessageId !== null ? { providerMessageId: row.providerMessageId } : {}),
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    ...(row.sentAt !== null ? { sentAt: row.sentAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

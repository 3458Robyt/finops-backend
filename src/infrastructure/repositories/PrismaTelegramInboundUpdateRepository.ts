import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  ClaimTelegramInboundUpdateInput,
  CompleteTelegramInboundUpdateInput,
  CreateTelegramInboundUpdateInput,
} from '../../domain/interfaces/ITelegramRepository.js';
import type { TelegramInboundUpdate } from '../../domain/models/Telegram.js';

/** Persistencia idempotente y con lease de los updates entrantes de Telegram. */
export class PrismaTelegramInboundUpdateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async enqueue(input: CreateTelegramInboundUpdateInput): Promise<'ENQUEUED' | 'DUPLICATE'> {
    try {
      await this.prisma.telegramInboundUpdate.create({
        data: { updateId: input.updateId, payload: input.payload as Prisma.InputJsonValue },
      });
      return 'ENQUEUED';
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'DUPLICATE';
      throw error;
    }
  }

  public async claim(input: ClaimTelegramInboundUpdateInput): Promise<TelegramInboundUpdate | null> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "telegram_inbound_updates"
        SET "status" = 'FAILED', "error_message" = 'El update agotó sus intentos después de una interrupción.',
            "locked_at" = NULL, "locked_by" = NULL, "updated_at" = NOW()
        WHERE "status" = 'PROCESSING'
          AND ("locked_at" IS NULL OR "locked_at" < ${input.leaseExpiredBefore})
          AND "attempt_count" >= "max_attempts"
      `;
      await tx.$executeRaw`
        UPDATE "telegram_inbound_updates"
        SET "status" = 'PENDING', "locked_at" = NULL, "locked_by" = NULL,
            "next_attempt_at" = NOW(), "updated_at" = NOW()
        WHERE "status" = 'PROCESSING'
          AND ("locked_at" IS NULL OR "locked_at" < ${input.leaseExpiredBefore})
          AND "attempt_count" < "max_attempts"
      `;
      const candidates = await tx.$queryRaw<readonly { readonly id: string }[]>`
        SELECT "id" FROM "telegram_inbound_updates"
        WHERE "status" = 'PENDING' AND "next_attempt_at" <= ${now}
          AND "attempt_count" < "max_attempts"
        ORDER BY "next_attempt_at" ASC, "created_at" ASC
        FOR UPDATE SKIP LOCKED LIMIT 1
      `;
      const candidate = candidates[0];
      if (candidate === undefined) return null;
      const row = await tx.telegramInboundUpdate.update({
        where: { id: candidate.id },
        data: { status: 'PROCESSING', attemptCount: { increment: 1 }, lockedAt: now, lockedBy: input.workerId },
      });
      return toInboundUpdate(row);
    });
  }

  public async complete(input: CompleteTelegramInboundUpdateInput): Promise<TelegramInboundUpdate | null> {
    const updated = await this.prisma.telegramInboundUpdate.updateMany({
      where: { id: input.id, status: 'PROCESSING', lockedBy: input.workerId },
      data: {
        status: input.status,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: input.nextAttemptAt ?? new Date(),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.status === 'PROCESSED' ? { processedAt: new Date(), errorMessage: null } : {}),
      },
    });
    if (updated.count === 0) return null;
    const row = await this.prisma.telegramInboundUpdate.findUnique({ where: { id: input.id } });
    return row === null ? null : toInboundUpdate(row);
  }
}

function toInboundUpdate(row: {
  readonly id: string;
  readonly updateId: string;
  readonly payload: unknown;
  readonly status: TelegramInboundUpdate['status'];
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date;
  readonly errorMessage: string | null;
}): TelegramInboundUpdate {
  return {
    id: row.id,
    updateId: row.updateId,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt,
    ...(row.errorMessage === null ? {} : { errorMessage: row.errorMessage }),
  };
}

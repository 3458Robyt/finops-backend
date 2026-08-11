import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  ConsumePasswordResetInput,
  CreatePasswordResetTokenInput,
  IAccountRecoveryRepository,
  PasswordResetTarget,
  PasswordResetTokenRecord,
} from '../../domain/interfaces/IAccountRecoveryRepository.js';

export class PrismaAccountRecoveryRepository implements IAccountRecoveryRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findUserByEmail(email: string): Promise<PasswordResetTarget | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, status: true },
    });
    return user === null ? null : { userId: user.id, email: user.email, name: user.name, status: user.status };
  }

  public async createPasswordResetToken(input: CreatePasswordResetTokenInput): Promise<void> {
    await this.prisma.passwordResetToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      },
    });
  }

  public async findPasswordResetToken(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    const token = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { userId: true, tokenHash: true, expiresAt: true, usedAt: true },
    });
    return token === null ? null : toTokenRecord(token);
  }

  public async consumeAndUpdatePassword(input: ConsumePasswordResetInput): Promise<PasswordResetTarget | null> {
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const token = await transaction.passwordResetToken.findUnique({
        where: { tokenHash: input.tokenHash },
        select: { id: true, userId: true, expiresAt: true, usedAt: true },
      });
      if (token === null || token.usedAt !== null || token.expiresAt <= now) return null;

      const claimed = await transaction.passwordResetToken.updateMany({
        where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return null;

      const user = await transaction.user.update({
        where: { id: token.userId },
        data: { passwordHash: input.passwordHash },
        select: { id: true, email: true, name: true, status: true },
      });
      return { userId: user.id, email: user.email, name: user.name, status: user.status };
    });
  }
}

function toTokenRecord(token: {
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}): PasswordResetTokenRecord {
  return {
    userId: token.userId,
    tokenHash: token.tokenHash,
    expiresAt: token.expiresAt,
    ...(token.usedAt === null ? {} : { usedAt: token.usedAt }),
  };
}

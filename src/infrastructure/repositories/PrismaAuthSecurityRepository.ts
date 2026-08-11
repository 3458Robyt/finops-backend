import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  AuthRefreshTokenRecord,
  CreateRefreshTokenInput,
  IAuthSecurityRepository,
  RotateRefreshTokenInput,
} from '../../domain/interfaces/IAuthSecurityRepository.js';

export class PrismaAuthSecurityRepository implements IAuthSecurityRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findRefreshToken(tokenHash: string): Promise<AuthRefreshTokenRecord | null> {
    const token = await this.prisma.authRefreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        sessionId: true,
        userId: true,
        tenantId: true,
        familyId: true,
        tokenHash: true,
        expiresAt: true,
        usedAt: true,
        revokedAt: true,
      },
    });

    return token === null ? null : toRefreshTokenRecord(token);
  }

  public async createRefreshToken(input: CreateRefreshTokenInput): Promise<void> {
    const session = await this.prisma.authSession.findUnique({
      where: { jwtId: input.sessionJwtId },
      select: { id: true },
    });

    if (session === null) {
      throw new Error('Cannot create refresh token for an unknown auth session');
    }

    await this.prisma.authRefreshToken.create({
      data: {
        sessionId: session.id,
        userId: input.userId,
        tenantId: input.tenantId,
        familyId: input.familyId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      },
    });
  }

  public async rotateRefreshToken(input: RotateRefreshTokenInput): Promise<boolean> {
    const now = new Date();

    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.authRefreshToken.findUnique({
        where: { tokenHash: input.tokenHash },
        select: {
          id: true,
          sessionId: true,
          userId: true,
          tenantId: true,
          familyId: true,
          expiresAt: true,
          usedAt: true,
          revokedAt: true,
        },
      });

      if (current === null) return false;

      const claimed = await transaction.authRefreshToken.updateMany({
        where: {
          id: current.id,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });

      if (claimed.count !== 1) return false;

      const session = await transaction.authSession.updateMany({
        where: {
          id: current.sessionId,
          userId: current.userId,
          revokedAt: null,
        },
        data: {
          jwtId: input.newJwtId,
          expiresAt: input.sessionExpiresAt,
        },
      });

      if (session.count !== 1) {
        await transaction.authRefreshToken.update({
          where: { id: current.id },
          data: { revokedAt: now },
        });
        return false;
      }

      await transaction.authRefreshToken.create({
        data: {
          sessionId: current.sessionId,
          userId: current.userId,
          tenantId: current.tenantId,
          familyId: current.familyId,
          tokenHash: input.replacementTokenHash,
          expiresAt: input.replacementExpiresAt,
          ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
          ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
        },
      });

      return true;
    });
  }

  public async revokeRefreshFamily(familyId: string): Promise<void> {
    const tokens = await this.prisma.authRefreshToken.findMany({
      where: { familyId },
      select: { sessionId: true },
    });
    const sessionIds = [...new Set(tokens.map((token) => token.sessionId))];
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.authRefreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: now },
      }),
      ...(sessionIds.length === 0 ? [] : [this.prisma.authSession.updateMany({
        where: { id: { in: sessionIds }, revokedAt: null },
        data: { revokedAt: now },
      })]),
    ]);
  }

  public async revokeRefreshTokensForSession(sessionId: string): Promise<void> {
    await this.prisma.authRefreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  public async revokeRefreshTokensForUser(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.authRefreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId === undefined ? {} : { sessionId: { not: exceptSessionId } }),
      },
      data: { revokedAt: new Date() },
    });
  }
}

function toRefreshTokenRecord(token: {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
}): AuthRefreshTokenRecord {
  return {
    id: token.id,
    sessionId: token.sessionId,
    userId: token.userId,
    tenantId: token.tenantId,
    familyId: token.familyId,
    tokenHash: token.tokenHash,
    expiresAt: token.expiresAt,
    ...(token.usedAt === null ? {} : { usedAt: token.usedAt }),
    ...(token.revokedAt === null ? {} : { revokedAt: token.revokedAt }),
  };
}

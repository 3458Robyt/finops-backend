import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  AuthSessionSummary,
  IAuthSessionRepository,
} from '../../domain/interfaces/IAuthSessionRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { IAuthSecurityRepository } from '../../domain/interfaces/IAuthSecurityRepository.js';

export class PrismaAuthSessionRepository implements IAuthSessionRepository {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly security?: IAuthSecurityRepository,
  ) {}

  public async isActive(input: AuthContext): Promise<boolean> {
    const session = await this.prisma.authSession.findUnique({
      where: { jwtId: input.jwtId },
      select: {
        id: true,
        userId: true,
        tenantId: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            status: true,
            role: true,
            tenantId: true,
          },
        },
      },
    });

    if (
      session === null
      || session.userId !== input.userId
      || session.revokedAt !== null
      || session.expiresAt <= new Date()
      || session.user.status !== 'ACTIVE'
      || session.user.role !== input.role
      || session.tenantId !== input.tenantId
    ) {
      return false;
    }

    if (session.user.role === 'MASTER_ADMIN') {
      return this.hasActiveTenant(input.tenantId);
    }

    if (session.user.tenantId === input.tenantId) {
      return this.hasActiveTenant(input.tenantId);
    }

    const assignment = await this.prisma.tenantAccessAssignment.findFirst({
      where: {
        userId: input.userId,
        tenantId: input.tenantId,
        disabledAt: null,
        tenant: { status: 'ACTIVE' },
      },
      select: { id: true },
    });

    return assignment !== null;
  }

  public async revokeCurrent(actor: AuthContext): Promise<boolean> {
    const result = await this.prisma.authSession.updateMany({
      where: {
        userId: actor.userId,
        jwtId: actor.jwtId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    if (result.count > 0) {
      const session = await this.prisma.authSession.findUnique({
        where: { jwtId: actor.jwtId },
        select: { id: true },
      });
      if (session !== null) {
        await this.security?.revokeRefreshTokensForSession(session.id);
      }
    }

    return result.count > 0;
  }

  public async revokeAll(userId: string, exceptJwtId?: string): Promise<number> {
    const result = await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptJwtId === undefined ? {} : { jwtId: { not: exceptJwtId } }),
      },
      data: { revokedAt: new Date() },
    });

    await this.security?.revokeRefreshTokensForUser(userId);

    return result.count;
  }

  public async listActive(
    userId: string,
    currentJwtId: string,
  ): Promise<readonly AuthSessionSummary[]> {
    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { issuedAt: 'desc' },
      select: {
        id: true,
        jwtId: true,
        issuedAt: true,
        expiresAt: true,
        revokedAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });

    return sessions.map((session) => ({
      id: session.id,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      ...(session.revokedAt === null ? {} : { revokedAt: session.revokedAt }),
      ...(session.ipAddress === null ? {} : { ipAddress: session.ipAddress }),
      ...(session.userAgent === null ? {} : { userAgent: session.userAgent.slice(0, 240) }),
      isCurrent: session.jwtId === currentJwtId,
    }));
  }

  public async revokeById(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.prisma.authSession.updateMany({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return result.count > 0;
  }

  private async hasActiveTenant(tenantId: string): Promise<boolean> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, status: 'ACTIVE' },
      select: { id: true },
    });

    return tenant !== null;
  }
}

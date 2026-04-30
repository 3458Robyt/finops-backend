import type {
  AuthUser,
  CreateSessionInput,
  IUserRepository,
} from '../../domain/interfaces/IUserRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

export class PrismaUserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findByEmail(email: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        tenantId: true,
        email: true,
        name: true,
        passwordHash: true,
        role: true,
        status: true,
      },
    });

    if (user === null) {
      return null;
    }

    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      passwordHash: user.passwordHash,
      role: user.role,
      status: user.status,
    };
  }

  public async updateLastLogin(userId: string, loggedInAt: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: loggedInAt },
    });
  }

  public async createSession(input: CreateSessionInput): Promise<void> {
    await this.prisma.authSession.create({
      data: {
        userId: input.userId,
        jwtId: input.jwtId,
        expiresAt: input.expiresAt,
        ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
        ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      },
    });
  }
}

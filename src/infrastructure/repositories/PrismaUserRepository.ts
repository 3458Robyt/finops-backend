import type {
  AccessibleTenant,
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
      select: authUserSelect,
    });

    return user === null ? null : toAuthUser(user);
  }

  public async findById(userId: string): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: authUserSelect,
    });

    return user === null ? null : toAuthUser(user);
  }

  public async listAccessibleTenants(user: AuthUser): Promise<readonly AccessibleTenant[]> {
    if (user.role === 'MASTER_ADMIN') {
      const tenants = await this.prisma.tenant.findMany({
        where: { status: 'ACTIVE' },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, slug: true },
      });

      return tenants.map((tenant) => ({
        ...tenant,
        accessRole: 'MASTER',
      }));
    }

    const [homeTenant, assignments] = await Promise.all([
      this.prisma.tenant.findFirst({
        where: {
          id: user.tenantId,
          status: 'ACTIVE',
        },
        select: { id: true, name: true, slug: true },
      }),
      this.prisma.tenantAccessAssignment.findMany({
        where: {
          userId: user.id,
          disabledAt: null,
          tenant: { status: 'ACTIVE' },
        },
        orderBy: { tenant: { name: 'asc' } },
        select: {
          role: true,
          tenant: {
            select: { id: true, name: true, slug: true },
          },
        },
      }),
    ]);

    const tenantsById = new Map<string, AccessibleTenant>();

    if (homeTenant !== null) {
      tenantsById.set(homeTenant.id, {
        ...homeTenant,
        accessRole: 'HOME',
      });
    }

    for (const assignment of assignments) {
      if (!tenantsById.has(assignment.tenant.id)) {
        tenantsById.set(assignment.tenant.id, {
          ...assignment.tenant,
          accessRole: assignment.role,
        });
      }
    }

    return [...tenantsById.values()].sort((left, right) => left.name.localeCompare(right.name));
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

const authUserSelect = {
  id: true,
  tenantId: true,
  email: true,
  name: true,
  passwordHash: true,
  role: true,
  status: true,
} as const;

function toAuthUser(user: {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly role: AuthUser['role'];
  readonly status: AuthUser['status'];
}): AuthUser {
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

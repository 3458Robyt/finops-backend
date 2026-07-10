import type {
  CreateMasterAdminAuditEventInput,
  CreateMasterAdminTenantInput,
  CreateMasterAdminUserInput,
  IMasterAdminRepository,
  MasterAdminActor,
  MasterAdminAssignment,
  MasterAdminTenant,
  MasterAdminUser,
  UpdateMasterAdminTenantInput,
  UpsertTenantAssignmentInput,
} from '../../domain/interfaces/IMasterAdminRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Prisma } from '../../generated/prisma/client.js';

export class PrismaMasterAdminRepository implements IMasterAdminRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findActor(userId: string): Promise<MasterAdminActor | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenantId: true, operatorOrganizationId: true, role: true },
    });

    return user;
  }

  public async findTenant(tenantId: string): Promise<MasterAdminTenant | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: tenantSelect,
    });

    if (tenant === null) return null;
    const activeAssignments = await this.countActiveAssignments([tenant.id]);
    return toTenant(tenant, activeAssignments.get(tenant.id) ?? 0);
  }

  public async findUser(userId: string): Promise<MasterAdminUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: userSelect,
    });

    return user;
  }

  public async findUserByEmail(email: string): Promise<MasterAdminUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: userSelect,
    });

    return user;
  }

  public async listTenants(): Promise<readonly MasterAdminTenant[]> {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      select: tenantSelect,
    });
    const activeAssignments = await this.countActiveAssignments(tenants.map((tenant) => tenant.id));

    return tenants.map((tenant) => toTenant(tenant, activeAssignments.get(tenant.id) ?? 0));
  }

  public async createTenant(input: CreateMasterAdminTenantInput): Promise<MasterAdminTenant> {
    const tenant = await this.prisma.tenant.create({
      data: {
        name: input.name,
        slug: input.slug,
        operatorOrganizationId: input.operatorOrganizationId,
      },
      select: tenantSelect,
    });

    return toTenant(tenant, 0);
  }

  public async updateTenant(input: UpdateMasterAdminTenantInput): Promise<MasterAdminTenant> {
    const tenant = await this.prisma.tenant.update({
      where: { id: input.tenantId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      select: tenantSelect,
    });
    const activeAssignments = await this.countActiveAssignments([tenant.id]);

    return toTenant(tenant, activeAssignments.get(tenant.id) ?? 0);
  }

  public async listStaffUsers(): Promise<readonly MasterAdminUser[]> {
    return this.prisma.user.findMany({
      where: {
        role: { in: ['MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN', 'ADMIN'] },
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: userSelect,
    });
  }

  public async createUser(input: CreateMasterAdminUserInput): Promise<MasterAdminUser> {
    return this.prisma.user.create({
      data: {
        tenantId: input.tenantId,
        operatorOrganizationId: input.operatorOrganizationId,
        name: input.name,
        email: input.email,
        passwordHash: input.passwordHash,
        role: input.role,
      },
      select: userSelect,
    });
  }

  public async listAssignments(): Promise<readonly MasterAdminAssignment[]> {
    const assignments = await this.prisma.tenantAccessAssignment.findMany({
      where: { disabledAt: null },
      orderBy: [{ tenant: { name: 'asc' } }, { user: { name: 'asc' } }],
      select: assignmentSelect,
    });

    return assignments.map(toAssignment);
  }

  public async upsertAssignment(input: UpsertTenantAssignmentInput): Promise<MasterAdminAssignment> {
    const existing = await this.prisma.tenantAccessAssignment.findUnique({
      where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
      select: { id: true },
    });

    const assignment = existing === null
      ? await this.prisma.tenantAccessAssignment.create({
          data: {
            tenantId: input.tenantId,
            userId: input.userId,
            role: input.role,
          },
          select: assignmentSelect,
        })
      : await this.prisma.tenantAccessAssignment.update({
          where: { id: existing.id },
          data: { role: input.role, disabledAt: null },
          select: assignmentSelect,
        });

    return toAssignment(assignment);
  }

  public async revokeAssignment(tenantId: string, userId: string): Promise<MasterAdminAssignment | null> {
    const existing = await this.prisma.tenantAccessAssignment.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { id: true },
    });

    if (existing === null) return null;

    const assignment = await this.prisma.tenantAccessAssignment.update({
      where: { id: existing.id },
      data: { disabledAt: new Date() },
      select: assignmentSelect,
    });

    return toAssignment(assignment);
  }

  public async createAuditEvent(input: CreateMasterAdminAuditEventInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
        ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
      },
    });
  }

  private async countActiveAssignments(tenantIds: readonly string[]): Promise<Map<string, number>> {
    if (tenantIds.length === 0) return new Map();

    const counts = await this.prisma.tenantAccessAssignment.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: [...tenantIds] }, disabledAt: null },
      _count: { tenantId: true },
    });

    return new Map(counts.map((count) => [count.tenantId, count._count.tenantId]));
  }
}

const tenantSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const userSelect = {
  id: true,
  tenantId: true,
  name: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const assignmentSelect = {
  id: true,
  tenantId: true,
  userId: true,
  role: true,
  createdAt: true,
  disabledAt: true,
  tenant: { select: { name: true } },
  user: { select: { name: true, email: true } },
} as const;

function toTenant(tenant: Omit<MasterAdminTenant, 'assignedUsers'>, assignedUsers: number): MasterAdminTenant {
  return { ...tenant, assignedUsers };
}

function toAssignment(assignment: {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: MasterAdminAssignment['role'];
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
  readonly tenant: { readonly name: string };
  readonly user: { readonly name: string; readonly email: string };
}): MasterAdminAssignment {
  return {
    id: assignment.id,
    tenantId: assignment.tenantId,
    tenantName: assignment.tenant.name,
    userId: assignment.userId,
    userName: assignment.user.name,
    userEmail: assignment.user.email,
    role: assignment.role,
    createdAt: assignment.createdAt,
    disabledAt: assignment.disabledAt,
  };
}

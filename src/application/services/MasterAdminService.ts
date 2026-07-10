import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type {
  IMasterAdminRepository,
  MasterAdminAssignment,
  MasterAdminTenant,
  MasterAdminUser,
} from '../../domain/interfaces/IMasterAdminRepository.js';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { TenantAccessRole, TenantStatus, UserRole } from '../../generated/prisma/client.js';

export interface RequestAuditMetadata {
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface CreateTenantCommand {
  readonly actorUserId: string;
  readonly name: string;
  readonly slug?: string;
  readonly request?: RequestAuditMetadata;
}

export interface UpdateTenantCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly name?: string;
  readonly status?: TenantStatus;
  readonly request?: RequestAuditMetadata;
}

export interface CreateStaffUserCommand {
  readonly actorUserId: string;
  readonly name: string;
  readonly email: string;
  readonly role: UserRole;
  readonly temporaryPassword: string;
  readonly request?: RequestAuditMetadata;
}

export interface AssignTenantCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly accessRole: TenantAccessRole;
  readonly request?: RequestAuditMetadata;
}

export interface RevokeTenantCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly request?: RequestAuditMetadata;
}

export class MasterAdminService {
  public constructor(
    private readonly repository: IMasterAdminRepository,
    private readonly passwordHasher: IPasswordHasher,
  ) {}

  public async listTenants(actorUserId: string): Promise<readonly MasterAdminTenant[]> {
    await this.requireMasterAdmin(actorUserId);
    return this.repository.listTenants();
  }

  public async createTenant(command: CreateTenantCommand): Promise<MasterAdminTenant> {
    const actor = await this.requireMasterAdmin(command.actorUserId);
    const name = this.normalizeName(command.name, 'name');
    const slug = this.normalizeSlug(command.slug ?? name);
    const tenant = await this.repository.createTenant({
      name,
      slug,
      operatorOrganizationId: actor.operatorOrganizationId,
    });

    await this.audit(actor.id, tenant.id, 'MASTER_ADMIN_TENANT_CREATED', 'Tenant', tenant.id, {
      name,
      slug,
      ...command.request,
    });

    return tenant;
  }

  public async updateTenant(command: UpdateTenantCommand): Promise<MasterAdminTenant> {
    const actor = await this.requireMasterAdmin(command.actorUserId);
    await this.requireTenant(command.tenantId);

    const name = command.name === undefined ? undefined : this.normalizeName(command.name, 'name');
    const status = command.status;
    if (name === undefined && status === undefined) {
      throw new FinOpsBaseError('At least one tenant field must be provided', 'VALIDATION_ERROR');
    }

    const tenant = await this.repository.updateTenant({
      tenantId: command.tenantId,
      ...(name !== undefined ? { name } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    await this.audit(actor.id, tenant.id, 'MASTER_ADMIN_TENANT_UPDATED', 'Tenant', tenant.id, {
      name,
      status,
      ...command.request,
    });

    return tenant;
  }

  public async listStaffUsers(actorUserId: string): Promise<readonly MasterAdminUser[]> {
    await this.requireMasterAdmin(actorUserId);
    return this.repository.listStaffUsers();
  }

  public async createStaffUser(command: CreateStaffUserCommand): Promise<MasterAdminUser> {
    const actor = await this.requireMasterAdmin(command.actorUserId);
    const name = this.normalizeName(command.name, 'name');
    const email = this.normalizeEmail(command.email);
    const role = this.normalizeStaffRole(command.role);
    const temporaryPassword = this.normalizePassword(command.temporaryPassword);

    const existing = await this.repository.findUserByEmail(email);
    if (existing !== null) {
      throw new FinOpsBaseError('A user with this email already exists', 'CONFLICT');
    }

    const passwordHash = await this.passwordHasher.hash(temporaryPassword);
    const user = await this.repository.createUser({
      tenantId: actor.tenantId,
      operatorOrganizationId: actor.operatorOrganizationId,
      name,
      email,
      role,
      passwordHash,
    });

    await this.audit(actor.id, actor.tenantId, 'MASTER_ADMIN_USER_CREATED', 'User', user.id, {
      email,
      role,
      ...command.request,
    });

    return user;
  }

  public async listAssignments(actorUserId: string): Promise<readonly MasterAdminAssignment[]> {
    await this.requireMasterAdmin(actorUserId);
    return this.repository.listAssignments();
  }

  public async assignTenant(command: AssignTenantCommand): Promise<MasterAdminAssignment> {
    const actor = await this.requireMasterAdmin(command.actorUserId);
    const tenant = await this.requireTenant(command.tenantId);
    const user = await this.requireUser(command.userId);
    const accessRole = this.normalizeAccessRole(command.accessRole);

    if (user.status !== 'ACTIVE') {
      throw new FinOpsBaseError('Only active users can be assigned to tenants', 'VALIDATION_ERROR');
    }

    const assignment = await this.repository.upsertAssignment({
      tenantId: tenant.id,
      userId: user.id,
      role: accessRole,
    });

    await this.audit(actor.id, tenant.id, 'MASTER_ADMIN_TENANT_ASSIGNED', 'TenantAccessAssignment', assignment.id, {
      tenantId: tenant.id,
      userId: user.id,
      accessRole,
      ...command.request,
    });

    return assignment;
  }

  public async revokeTenant(command: RevokeTenantCommand): Promise<MasterAdminAssignment> {
    const actor = await this.requireMasterAdmin(command.actorUserId);
    const tenant = await this.requireTenant(command.tenantId);
    await this.requireUser(command.userId);

    const assignment = await this.repository.revokeAssignment(command.tenantId, command.userId);
    if (assignment === null) {
      throw new FinOpsBaseError('Tenant assignment not found', 'NOT_FOUND');
    }

    await this.audit(actor.id, tenant.id, 'MASTER_ADMIN_TENANT_REVOKED', 'TenantAccessAssignment', assignment.id, {
      tenantId: command.tenantId,
      userId: command.userId,
      ...command.request,
    });

    return assignment;
  }

  private async requireMasterAdmin(userId: string) {
    const actor = await this.repository.findActor(userId);
    if (actor === null) {
      throw new AuthorizationError('Authenticated user not found');
    }
    if (actor.role !== 'MASTER_ADMIN') {
      throw new AuthorizationError('Only the master administrator can manage tenants and assignments');
    }

    return actor;
  }

  private async requireTenant(tenantId: string): Promise<MasterAdminTenant> {
    const tenant = await this.repository.findTenant(tenantId);
    if (tenant === null) {
      throw new FinOpsBaseError('Tenant not found', 'NOT_FOUND');
    }

    return tenant;
  }

  private async requireUser(userId: string): Promise<MasterAdminUser> {
    const user = await this.repository.findUser(userId);
    if (user === null) {
      throw new FinOpsBaseError('User not found', 'NOT_FOUND');
    }

    if (!['MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN', 'ADMIN'].includes(user.role)) {
      throw new FinOpsBaseError('Only operator staff users can be assigned through this module', 'VALIDATION_ERROR');
    }

    return user;
  }

  private normalizeName(value: string, fieldName: string): string {
    const normalized = value.trim();
    if (normalized.length < 2 || normalized.length > 120) {
      throw new FinOpsBaseError(`${fieldName} must contain between 2 and 120 characters`, 'VALIDATION_ERROR');
    }

    return normalized;
  }

  private normalizeSlug(value: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
      throw new FinOpsBaseError('slug must contain lowercase letters, numbers and hyphens only', 'VALIDATION_ERROR');
    }

    return slug;
  }

  private normalizeEmail(value: string): string {
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new FinOpsBaseError('email must be valid', 'VALIDATION_ERROR');
    }

    return email;
  }

  private normalizePassword(value: string): string {
    if (value.length < 8 || value.length > 128) {
      throw new FinOpsBaseError('temporaryPassword must contain between 8 and 128 characters', 'VALIDATION_ERROR');
    }

    return value;
  }

  private normalizeStaffRole(role: UserRole): UserRole {
    if (role !== 'OPERATOR_ADMIN' && role !== 'FINOPS_TECHNICIAN') {
      throw new FinOpsBaseError('role must be OPERATOR_ADMIN or FINOPS_TECHNICIAN', 'VALIDATION_ERROR');
    }

    return role;
  }

  private normalizeAccessRole(role: TenantAccessRole): TenantAccessRole {
    if (role !== 'TECHNICIAN' && role !== 'LEAD_TECHNICIAN' && role !== 'OPERATOR_ADMIN') {
      throw new FinOpsBaseError('accessRole is not supported', 'VALIDATION_ERROR');
    }

    return role;
  }

  private async audit(
    actorUserId: string,
    tenantId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const { ipAddress, userAgent, ...rest } = metadata;
    await this.repository.createAuditEvent({
      tenantId,
      actorUserId,
      action,
      entityType,
      entityId,
      metadata: rest,
      ...(typeof ipAddress === 'string' ? { ipAddress } : {}),
      ...(typeof userAgent === 'string' ? { userAgent } : {}),
    });
  }
}

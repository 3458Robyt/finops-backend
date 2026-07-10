import { describe, expect, test } from 'vitest';
import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
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
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import { MasterAdminService } from './MasterAdminService.js';

class FakePasswordHasher implements IPasswordHasher {
  public hashedPasswords: string[] = [];

  public async hash(password: string): Promise<string> {
    this.hashedPasswords.push(password);
    return `hashed:${password}`;
  }

  public async verify(): Promise<boolean> {
    return true;
  }
}

class FakeMasterAdminRepository implements IMasterAdminRepository {
  public actor: MasterAdminActor | null = {
    id: 'master-1',
    tenantId: 'operator-tenant',
    operatorOrganizationId: 'operator-org',
    role: 'MASTER_ADMIN',
  };
  public tenants: MasterAdminTenant[] = [buildTenant('tenant-1', 'Cliente Uno')];
  public users: MasterAdminUser[] = [buildUser('tech-1', 'Tecnico Uno', 'tech@example.com', 'FINOPS_TECHNICIAN')];
  public assignments: MasterAdminAssignment[] = [];
  public audits: CreateMasterAdminAuditEventInput[] = [];
  public createdUserInput: CreateMasterAdminUserInput | null = null;

  public async findActor(): Promise<MasterAdminActor | null> {
    return this.actor;
  }

  public async findTenant(tenantId: string): Promise<MasterAdminTenant | null> {
    return this.tenants.find((tenant) => tenant.id === tenantId) ?? null;
  }

  public async findUser(userId: string): Promise<MasterAdminUser | null> {
    return this.users.find((user) => user.id === userId) ?? null;
  }

  public async findUserByEmail(email: string): Promise<MasterAdminUser | null> {
    return this.users.find((user) => user.email === email) ?? null;
  }

  public async listTenants(): Promise<readonly MasterAdminTenant[]> {
    return this.tenants;
  }

  public async createTenant(input: CreateMasterAdminTenantInput): Promise<MasterAdminTenant> {
    const tenant = buildTenant('tenant-created', input.name, input.slug);
    this.tenants.push(tenant);
    return tenant;
  }

  public async updateTenant(input: UpdateMasterAdminTenantInput): Promise<MasterAdminTenant> {
    const tenant = await this.findTenant(input.tenantId);
    if (tenant === null) throw new FinOpsBaseError('Tenant not found', 'NOT_FOUND');
    const updated = { ...tenant, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.status !== undefined ? { status: input.status } : {}) };
    this.tenants = this.tenants.map((item) => (item.id === input.tenantId ? updated : item));
    return updated;
  }

  public async listStaffUsers(): Promise<readonly MasterAdminUser[]> {
    return this.users;
  }

  public async createUser(input: CreateMasterAdminUserInput): Promise<MasterAdminUser> {
    this.createdUserInput = input;
    const user = buildUser('created-user', input.name, input.email, input.role, input.tenantId);
    this.users.push(user);
    return user;
  }

  public async listAssignments(): Promise<readonly MasterAdminAssignment[]> {
    return this.assignments.filter((assignment) => assignment.disabledAt === null);
  }

  public async upsertAssignment(input: UpsertTenantAssignmentInput): Promise<MasterAdminAssignment> {
    const tenant = await this.findTenant(input.tenantId);
    const user = await this.findUser(input.userId);
    if (tenant === null || user === null) throw new FinOpsBaseError('Missing fixture', 'NOT_FOUND');
    const assignment = {
      id: 'assignment-1',
      tenantId: tenant.id,
      tenantName: tenant.name,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      role: input.role,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      disabledAt: null,
    } satisfies MasterAdminAssignment;
    this.assignments = [assignment];
    return assignment;
  }

  public async revokeAssignment(tenantId: string, userId: string): Promise<MasterAdminAssignment | null> {
    const assignment = this.assignments.find((item) => item.tenantId === tenantId && item.userId === userId);
    if (assignment === undefined) return null;
    const revoked = { ...assignment, disabledAt: new Date('2026-01-02T00:00:00.000Z') };
    this.assignments = [revoked];
    return revoked;
  }

  public async createAuditEvent(input: CreateMasterAdminAuditEventInput): Promise<void> {
    this.audits.push(input);
  }
}

describe('MasterAdminService', () => {
  test('rejects non master users', async () => {
    const repository = new FakeMasterAdminRepository();
    repository.actor = { ...repository.actor!, role: 'FINOPS_TECHNICIAN' };
    const service = new MasterAdminService(repository, new FakePasswordHasher());

    await expect(service.listTenants('tech-1')).rejects.toBeInstanceOf(AuthorizationError);
  });

  test('creates staff users under the master home tenant', async () => {
    const repository = new FakeMasterAdminRepository();
    const hasher = new FakePasswordHasher();
    const service = new MasterAdminService(repository, hasher);

    const user = await service.createStaffUser({
      actorUserId: 'master-1',
      name: 'Nueva Tecnica',
      email: 'NUEVA@example.com',
      role: 'FINOPS_TECHNICIAN',
      temporaryPassword: 'Temporal123',
    });

    expect(user.email).toBe('nueva@example.com');
    expect(repository.createdUserInput).toMatchObject({
      tenantId: 'operator-tenant',
      operatorOrganizationId: 'operator-org',
      passwordHash: 'hashed:Temporal123',
    });
    expect(repository.audits[0]).toMatchObject({ action: 'MASTER_ADMIN_USER_CREATED', entityType: 'User' });
  });

  test('assigns and revokes tenants for staff users', async () => {
    const repository = new FakeMasterAdminRepository();
    const service = new MasterAdminService(repository, new FakePasswordHasher());

    const assignment = await service.assignTenant({
      actorUserId: 'master-1',
      tenantId: 'tenant-1',
      userId: 'tech-1',
      accessRole: 'LEAD_TECHNICIAN',
    });
    const revoked = await service.revokeTenant({
      actorUserId: 'master-1',
      tenantId: 'tenant-1',
      userId: 'tech-1',
    });

    expect(assignment.role).toBe('LEAD_TECHNICIAN');
    expect(revoked.disabledAt).toBeInstanceOf(Date);
    expect(repository.audits.map((audit) => audit.action)).toEqual([
      'MASTER_ADMIN_TENANT_ASSIGNED',
      'MASTER_ADMIN_TENANT_REVOKED',
    ]);
  });
});

function buildTenant(id: string, name: string, slug = name.toLowerCase().replace(/\s+/g, '-')): MasterAdminTenant {
  return {
    id,
    name,
    slug,
    status: 'ACTIVE',
    assignedUsers: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function buildUser(
  id: string,
  name: string,
  email: string,
  role: MasterAdminUser['role'],
  tenantId = 'operator-tenant',
): MasterAdminUser {
  return {
    id,
    tenantId,
    name,
    email,
    role,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

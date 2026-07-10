import type { TenantAccessRole, TenantStatus, UserRole, UserStatus } from '../../generated/prisma/client.js';

export interface MasterAdminActor {
  readonly id: string;
  readonly tenantId: string;
  readonly operatorOrganizationId: string | null;
  readonly role: UserRole;
}

export interface MasterAdminTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: TenantStatus;
  readonly assignedUsers: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MasterAdminUser {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MasterAdminAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly userId: string;
  readonly userName: string;
  readonly userEmail: string;
  readonly role: TenantAccessRole;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
}

export interface CreateMasterAdminTenantInput {
  readonly name: string;
  readonly slug: string;
  readonly operatorOrganizationId: string | null;
}

export interface UpdateMasterAdminTenantInput {
  readonly tenantId: string;
  readonly name?: string;
  readonly status?: TenantStatus;
}

export interface CreateMasterAdminUserInput {
  readonly tenantId: string;
  readonly operatorOrganizationId: string | null;
  readonly name: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: UserRole;
}

export interface UpsertTenantAssignmentInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantAccessRole;
}

export interface CreateMasterAdminAuditEventInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface IMasterAdminRepository {
  findActor(userId: string): Promise<MasterAdminActor | null>;
  findTenant(tenantId: string): Promise<MasterAdminTenant | null>;
  findUser(userId: string): Promise<MasterAdminUser | null>;
  findUserByEmail(email: string): Promise<MasterAdminUser | null>;
  listTenants(): Promise<readonly MasterAdminTenant[]>;
  createTenant(input: CreateMasterAdminTenantInput): Promise<MasterAdminTenant>;
  updateTenant(input: UpdateMasterAdminTenantInput): Promise<MasterAdminTenant>;
  listStaffUsers(): Promise<readonly MasterAdminUser[]>;
  createUser(input: CreateMasterAdminUserInput): Promise<MasterAdminUser>;
  listAssignments(): Promise<readonly MasterAdminAssignment[]>;
  upsertAssignment(input: UpsertTenantAssignmentInput): Promise<MasterAdminAssignment>;
  revokeAssignment(tenantId: string, userId: string): Promise<MasterAdminAssignment | null>;
  createAuditEvent(input: CreateMasterAdminAuditEventInput): Promise<void>;
}

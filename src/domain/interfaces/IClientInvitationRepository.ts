import type { UserRole } from '../../generated/prisma/client.js';

export interface ClientInvitationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly email: string;
  readonly invitedName: string | null;
  readonly role: Extract<UserRole, 'CLIENT_APPROVER' | 'CLIENT_VIEWER'>;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateClientInvitationInput {
  readonly tenantId: string;
  readonly createdByUserId: string;
  readonly email: string;
  readonly invitedName?: string;
  readonly role: Extract<UserRole, 'CLIENT_APPROVER' | 'CLIENT_VIEWER'>;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface AcceptClientInvitationInput {
  readonly tokenHash: string;
  readonly passwordHash: string;
  readonly name: string;
}

export interface AcceptedClientInvitation {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly role: Extract<UserRole, 'CLIENT_APPROVER' | 'CLIENT_VIEWER'>;
}

export interface IClientInvitationRepository {
  create(input: CreateClientInvitationInput): Promise<ClientInvitationRecord>;
  listByTenant(tenantId: string): Promise<readonly ClientInvitationRecord[]>;
  accept(input: AcceptClientInvitationInput): Promise<AcceptedClientInvitation>;
}

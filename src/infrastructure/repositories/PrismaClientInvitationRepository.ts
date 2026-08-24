import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type {
  AcceptClientInvitationInput,
  AcceptedClientInvitation,
  ClientInvitationRecord,
  CreateClientInvitationInput,
  IClientInvitationRepository,
} from '../../domain/interfaces/IClientInvitationRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { UserRole } from '../../generated/prisma/client.js';

export class PrismaClientInvitationRepository implements IClientInvitationRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async create(input: CreateClientInvitationInput): Promise<ClientInvitationRecord> {
    const invitation = await this.prisma.clientInvitation.create({
      data: {
        tenantId: input.tenantId,
        createdByUserId: input.createdByUserId,
        email: input.email,
        ...(input.invitedName === undefined ? {} : { invitedName: input.invitedName }),
        role: input.role,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
      select: invitationSelect,
    });
    return toInvitation(invitation);
  }

  public async listByTenant(tenantId: string): Promise<readonly ClientInvitationRecord[]> {
    const invitations = await this.prisma.clientInvitation.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: invitationSelect,
    });
    return invitations.map(toInvitation);
  }

  public async accept(input: AcceptClientInvitationInput): Promise<AcceptedClientInvitation> {
    return this.prisma.$transaction(async (transaction) => {
      const invitation = await transaction.clientInvitation.findFirst({
        where: {
          tokenHash: input.tokenHash,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          tenantId: true,
          email: true,
          role: true,
        },
      });

      if (invitation === null) {
        throw new FinOpsBaseError('La invitación no existe, expiró o ya fue utilizada', 'NOT_FOUND');
      }

      const existing = await transaction.user.findUnique({
        where: { email: invitation.email },
        select: { id: true },
      });
      if (existing !== null) {
        throw new FinOpsBaseError('Ya existe un usuario con este correo', 'CONFLICT');
      }

      const user = await transaction.user.create({
        data: {
          tenantId: invitation.tenantId,
          email: invitation.email,
          name: input.name,
          passwordHash: input.passwordHash,
          role: invitation.role,
        },
        select: { id: true, tenantId: true, email: true, name: true, role: true },
      });

      await transaction.clientInvitation.update({
        where: { id: invitation.id },
        data: { consumedAt: new Date() },
      });

      return {
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
        name: user.name,
        role: toClientRole(user.role),
      };
    });
  }
}

const invitationSelect = {
  id: true,
  tenantId: true,
  email: true,
  invitedName: true,
  role: true,
  expiresAt: true,
  consumedAt: true,
  revokedAt: true,
  createdAt: true,
  tenant: { select: { name: true, slug: true } },
} as const;

function toInvitation(invitation: {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly invitedName: string | null;
  readonly role: UserRole;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly tenant: { readonly name: string; readonly slug: string };
}): ClientInvitationRecord {
  return {
    id: invitation.id,
    tenantId: invitation.tenantId,
    tenantName: invitation.tenant.name,
    tenantSlug: invitation.tenant.slug,
    email: invitation.email,
    invitedName: invitation.invitedName,
    role: toClientRole(invitation.role),
    expiresAt: invitation.expiresAt,
    consumedAt: invitation.consumedAt,
    revokedAt: invitation.revokedAt,
    createdAt: invitation.createdAt,
  };
}

function toClientRole(role: UserRole): ClientInvitationRecord['role'] {
  if (role !== 'CLIENT_APPROVER' && role !== 'CLIENT_VIEWER') {
    throw new FinOpsBaseError('La invitación no tiene un rol de cliente válido', 'VALIDATION_ERROR');
  }
  return role;
}

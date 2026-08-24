import { FinOpsBaseError, AuthorizationError } from '../../domain/errors/errors.js';
import type { ClientInvitationRecord, IClientInvitationRepository } from '../../domain/interfaces/IClientInvitationRepository.js';
import type { IMasterAdminRepository } from '../../domain/interfaces/IMasterAdminRepository.js';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { OutboundMessageDelivery } from '../../domain/models/OutboundMessage.js';
import { requirePermission } from '../../domain/security/AuthorizationPolicy.js';
import { createOpaqueToken, hashOpaqueToken } from '../auth/opaqueToken.js';
import { safeErrorMessage } from '../observability/safeError.js';
import type { IEmailClient } from './EmailClient.js';

const INVITATION_TTL_SECONDS = 30 * 60;
const CLIENT_ROLES = ['CLIENT_APPROVER', 'CLIENT_VIEWER'] as const;
type ClientRole = (typeof CLIENT_ROLES)[number];
type InvitationEmailStatus = Extract<OutboundMessageDelivery['status'], 'SENT' | 'FAILED' | 'SKIPPED'>;
type InvitationEmailDelivery = { readonly status: InvitationEmailStatus; readonly errorMessage?: string };

export interface CreateClientInvitationCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name?: string;
  readonly role: ClientRole;
  readonly clientPortalUrl: string;
}

export interface ClientInvitationResult {
  readonly invitation: ClientInvitationRecord;
  /** Código en texto plano. Solo se devuelve durante la creación. */
  readonly inviteCode: string;
  readonly inviteUrl: string;
  /** Resultado del correo transaccional, sin persistir el enlace secreto. */
  readonly emailDelivery?: InvitationEmailDelivery;
}

export class ClientInvitationService {
  public constructor(
    private readonly invitations: IClientInvitationRepository,
    private readonly masterAdminRepository: IMasterAdminRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly outboundRepository?: IOutboundMessageRepository,
    private readonly emailClient?: IEmailClient,
  ) {}

  public async create(command: CreateClientInvitationCommand): Promise<ClientInvitationResult> {
    const actor = await this.masterAdminRepository.findActor(command.actorUserId);
    if (actor === null) throw new AuthorizationError('No se encontró el usuario autenticado');
    requirePermission(actor.role, 'TENANT_MANAGE', 'Solo el administrador maestro puede invitar clientes');

    const tenant = await this.masterAdminRepository.findTenant(command.tenantId);
    if (tenant === null) throw new FinOpsBaseError('Tenant not found', 'NOT_FOUND');
    if (tenant.status !== 'ACTIVE') throw new FinOpsBaseError('El tenant está suspendido', 'VALIDATION_ERROR');

    const email = this.normalizeEmail(command.email);
    if (await this.masterAdminRepository.findUserByEmail(email) !== null) {
      throw new FinOpsBaseError('Ya existe un usuario con este correo', 'CONFLICT');
    }

    const token = createOpaqueToken(INVITATION_TTL_SECONDS);
    const invitation = await this.invitations.create({
      tenantId: tenant.id,
      createdByUserId: actor.id,
      email,
      ...(command.name === undefined ? {} : { invitedName: this.normalizeName(command.name) }),
      role: command.role,
      tokenHash: hashOpaqueToken(token.value),
      expiresAt: token.expiresAt,
    });

    const portalUrl = command.clientPortalUrl.replace(/\/$/, '');
    const inviteUrl = `${portalUrl}/cliente/${encodeURIComponent(tenant.slug)}?invite=${encodeURIComponent(token.value)}`;
    const emailDelivery = await this.sendInvitationEmail({
      tenantId: tenant.id,
      invitationId: invitation.id,
      recipient: invitation.email,
      invitedName: invitation.invitedName ?? invitation.email,
      tenantName: tenant.name,
      inviteUrl,
      expiresAt: invitation.expiresAt,
    });
    return {
      invitation,
      inviteCode: token.value,
      inviteUrl,
      ...(emailDelivery === undefined ? {} : { emailDelivery }),
    };
  }

  public async list(actorUserId: string, tenantId: string): Promise<readonly ClientInvitationRecord[]> {
    const actor = await this.masterAdminRepository.findActor(actorUserId);
    if (actor === null) throw new AuthorizationError('No se encontró el usuario autenticado');
    requirePermission(actor.role, 'TENANT_MANAGE', 'Solo el administrador maestro puede consultar invitaciones');
    if (await this.masterAdminRepository.findTenant(tenantId) === null) {
      throw new FinOpsBaseError('Tenant not found', 'NOT_FOUND');
    }
    return this.invitations.listByTenant(tenantId);
  }

  public async accept(input: { readonly tokenHash: string; readonly password: string; readonly name: string }): Promise<{
    readonly userId: string;
    readonly email: string;
  }> {
    const password = input.password;
    if (password.length < 12 || password.length > 128) {
      throw new FinOpsBaseError('La contraseña debe tener entre 12 y 128 caracteres', 'VALIDATION_ERROR');
    }
    const passwordHash = await this.passwordHasher.hash(password);
    const accepted = await this.invitations.accept({
      tokenHash: hashOpaqueToken(input.tokenHash),
      passwordHash,
      name: this.normalizeName(input.name),
    });
    return { userId: accepted.userId, email: accepted.email };
  }

  private normalizeEmail(value: string): string {
    const email = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new FinOpsBaseError('email must be valid', 'VALIDATION_ERROR');
    }
    return email;
  }

  private normalizeName(value: string): string {
    const name = value.trim();
    if (name.length < 2 || name.length > 120) {
      throw new FinOpsBaseError('El nombre debe tener entre 2 y 120 caracteres', 'VALIDATION_ERROR');
    }
    return name;
  }

  private async sendInvitationEmail(input: {
    readonly tenantId: string;
    readonly invitationId: string;
    readonly recipient: string;
    readonly invitedName: string;
    readonly tenantName: string;
    readonly inviteUrl: string;
    readonly expiresAt: Date;
  }): Promise<InvitationEmailDelivery | undefined> {
    if (this.outboundRepository === undefined || this.emailClient === undefined) return undefined;

    const subject = 'Invitación al portal FinOps Inteligente';
    const preview = `Invitación al portal FinOps para ${input.tenantName}. El enlace se envía a ${input.recipient}.`;
    const metadata = { to: input.recipient, invitationId: input.invitationId };
    if (!this.emailClient.enabled) {
      return toInvitationEmailDelivery(await this.outboundRepository.create({
        tenantId: input.tenantId,
        channel: 'EMAIL',
        messageType: 'CLIENT_INVITATION',
        status: 'SKIPPED',
        subject,
        preview,
        errorMessage: 'Email channel disabled',
        metadata,
      }));
    }

    const text = [
      `Hola ${input.invitedName},`,
      '',
      `El administrador de FinOps Inteligente te invitó al portal del tenant ${input.tenantName}.`,
      'Usa este enlace para crear tu acceso de cliente:',
      input.inviteUrl,
      '',
      `El enlace expira el ${input.expiresAt.toISOString()} y solo puede utilizarse una vez.`,
      '',
      'Si no esperabas esta invitación, puedes ignorar este mensaje.',
    ].join('\n');

    try {
      const result = await this.emailClient.send({ to: input.recipient, subject, text });
      return toInvitationEmailDelivery(await this.outboundRepository.create({
        tenantId: input.tenantId,
        channel: 'EMAIL',
        messageType: 'CLIENT_INVITATION',
        status: 'SENT',
        subject,
        preview,
        ...(result.messageId === undefined ? {} : { providerMessageId: result.messageId }),
        sentAt: new Date(),
        metadata,
      }));
    } catch (error: unknown) {
      return toInvitationEmailDelivery(await this.outboundRepository.create({
        tenantId: input.tenantId,
        channel: 'EMAIL',
        messageType: 'CLIENT_INVITATION',
        status: 'FAILED',
        subject,
        preview,
        errorMessage: safeErrorMessage(error),
        metadata,
      }));
    }
  }
}

function toInvitationEmailDelivery(delivery: OutboundMessageDelivery): InvitationEmailDelivery {
  if (delivery.status === 'SENT' || delivery.status === 'FAILED' || delivery.status === 'SKIPPED') {
    return {
      status: delivery.status,
      ...(delivery.errorMessage === undefined ? {} : { errorMessage: delivery.errorMessage }),
    };
  }
  return { status: 'FAILED', errorMessage: 'Estado de entrega inesperado.' };
}

import { describe, expect, it, vi } from 'vitest';
import type { IMasterAdminRepository } from '../../domain/interfaces/IMasterAdminRepository.js';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { IClientInvitationRepository } from '../../domain/interfaces/IClientInvitationRepository.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { IEmailClient } from './EmailClient.js';
import { ClientInvitationService } from './ClientInvitationService.js';

describe('ClientInvitationService', () => {
  it('creates a short-lived, hashed invitation for the master admin', async () => {
    const invitations = {
      create: vi.fn(async (input) => ({
        id: 'invitation-1',
        tenantId: input.tenantId,
        tenantName: 'OCI Demo',
        tenantSlug: 'oci-demo',
        email: input.email,
        invitedName: input.invitedName ?? null,
        role: input.role,
        expiresAt: input.expiresAt,
        consumedAt: null,
        revokedAt: null,
        createdAt: new Date(),
      })),
    } as unknown as IClientInvitationRepository;
    const admin = buildAdminRepository('MASTER_ADMIN');
    const service = new ClientInvitationService(invitations, admin, buildPasswordHasher());

    const result = await service.create({
      actorUserId: 'master-1',
      tenantId: 'tenant-1',
      email: '  CLIENT@EXAMPLE.COM ',
      name: 'Cliente Demo',
      role: 'CLIENT_VIEWER',
      clientPortalUrl: 'https://finops.example.com/',
    });

    expect(result.invitation.email).toBe('client@example.com');
    expect(result.inviteUrl).toContain('https://finops.example.com/cliente/oci-demo?invite=');
    expect(result.inviteCode.length).toBeGreaterThanOrEqual(40);
    expect(result.invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((invitations.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not allow a client role to create invitations', async () => {
    const service = new ClientInvitationService(
      {} as IClientInvitationRepository,
      buildAdminRepository('CLIENT_VIEWER'),
      buildPasswordHasher(),
    );

    await expect(service.create({
      actorUserId: 'client-1',
      tenantId: 'tenant-1',
      email: 'client@example.com',
      role: 'CLIENT_VIEWER',
      clientPortalUrl: 'https://finops.example.com',
    })).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
  });

  it('sends the invitation by email without persisting the one-time URL in the delivery preview', async () => {
    const invitations = {
      create: vi.fn(async (input) => ({
        id: 'invitation-2',
        tenantId: input.tenantId,
        tenantName: 'OCI Demo',
        tenantSlug: 'oci-demo',
        email: input.email,
        invitedName: input.invitedName ?? null,
        role: input.role,
        expiresAt: input.expiresAt,
        consumedAt: null,
        revokedAt: null,
        createdAt: new Date(),
      })),
    } as unknown as IClientInvitationRepository;
    const outbound = {
      create: vi.fn(async (input) => ({
        id: 'delivery-1',
        tenantId: input.tenantId,
        channel: input.channel,
        messageType: input.messageType,
        status: input.status ?? 'PENDING',
        subject: input.subject,
        preview: input.preview,
        metadata: input.metadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    } as unknown as IOutboundMessageRepository;
    const email = {
      enabled: true,
      send: vi.fn(async () => ({ messageId: 'smtp-1' })),
    } satisfies IEmailClient;
    const service = new ClientInvitationService(
      invitations,
      buildAdminRepository('MASTER_ADMIN'),
      buildPasswordHasher(),
      outbound,
      email,
    );

    const result = await service.create({
      actorUserId: 'master-1',
      tenantId: 'tenant-1',
      email: 'client@example.com',
      role: 'CLIENT_VIEWER',
      clientPortalUrl: 'https://finops.example.com',
    });

    expect(result.emailDelivery).toMatchObject({ status: 'SENT' });
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'client@example.com',
      text: expect.stringContaining(result.inviteUrl),
    }));
    const deliveryInput = (outbound.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(deliveryInput.preview).not.toContain('invite=');
    expect(deliveryInput.body).toBeUndefined();
  });

  it('hashes the invitation code and password before accepting', async () => {
    const invitations = {
      accept: vi.fn(async (input) => ({
        userId: 'user-1',
        tenantId: 'tenant-1',
        email: 'client@example.com',
        name: input.name,
        role: 'CLIENT_VIEWER' as const,
      })),
    } as unknown as IClientInvitationRepository;
    const hasher = buildPasswordHasher();
    const service = new ClientInvitationService(invitations, buildAdminRepository('MASTER_ADMIN'), hasher);

    const result = await service.accept({
      tokenHash: 'opaque-invitation-code',
      name: 'Cliente Demo',
      password: 'una-contraseña-segura',
    });

    expect(result.userId).toBe('user-1');
    expect(hasher.hash).toHaveBeenCalledWith('una-contraseña-segura');
    expect((invitations.accept as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects passwords outside the portal policy', async () => {
    const invitations = { accept: vi.fn() } as unknown as IClientInvitationRepository;
    const service = new ClientInvitationService(invitations, buildAdminRepository('MASTER_ADMIN'), buildPasswordHasher());

    await expect(service.accept({
      tokenHash: 'opaque-invitation-code',
      name: 'Cliente Demo',
      password: 'short',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(invitations.accept).not.toHaveBeenCalled();
  });
});

function buildAdminRepository(role: 'MASTER_ADMIN' | 'CLIENT_VIEWER'): IMasterAdminRepository {
  return {
    findActor: vi.fn(async () => ({
      id: role === 'MASTER_ADMIN' ? 'master-1' : 'client-1',
      tenantId: 'tenant-1',
      operatorOrganizationId: null,
      role,
    })),
    findTenant: vi.fn(async () => ({
      id: 'tenant-1',
      name: 'OCI Demo',
      slug: 'oci-demo',
      status: 'ACTIVE' as const,
      assignedUsers: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    findUserByEmail: vi.fn(async () => null),
  } as unknown as IMasterAdminRepository;
}

function buildPasswordHasher(): IPasswordHasher {
  return {
    hash: vi.fn(async (value: string) => `hashed:${value}`),
    verify: vi.fn(async () => true),
  };
}

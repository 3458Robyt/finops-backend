import { describe, expect, it } from 'vitest';
import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type {
  CreateOrUpdateTelegramLinkInput,
  CreateTelegramAuditEventInput,
  CreateTelegramInteractionLogInput,
  ITelegramRepository,
} from '../../domain/interfaces/ITelegramRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { TelegramChatLink, TelegramInteractionLog, TelegramLinkedUser } from '../../domain/models/Telegram.js';
import type { ITelegramClient } from './TelegramClient.js';
import { TelegramLinkService } from './TelegramLinkService.js';

describe('TelegramLinkService', () => {
  it('rejects link creation by non-admin users', async () => {
    const service = new TelegramLinkService(new LinkRepositoryFake(), new ClientFake());

    await expect(service.createLink(clientActor(), {
      email: 'client@example.com',
      chatId: '123',
    })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('creates a link only for an active user in the actor tenant and records audit', async () => {
    const repository = new LinkRepositoryFake();
    const service = new TelegramLinkService(repository, new ClientFake());

    const link = await service.createLink(adminActor(), {
      email: 'client@example.com',
      chatId: '123',
      telegramUsername: '@client_user',
    });

    expect(link.tenantId).toBe('tenant-1');
    expect(link.userId).toBe('user-1');
    expect(link.telegramUsername).toBe('client_user');
    expect(repository.auditEvents[0]?.action).toBe('TELEGRAM_LINK_CREATED');
  });

  it('does not allow hijacking an active chat linked to another tenant', async () => {
    const repository = new LinkRepositoryFake();
    repository.existingByChatId = buildLink({ tenantId: 'tenant-2', userId: 'other-user' });
    const service = new TelegramLinkService(repository, new ClientFake());

    await expect(service.createLink(adminActor(), {
      email: 'client@example.com',
      chatId: '123',
    })).rejects.toMatchObject<Partial<FinOpsBaseError>>({ code: 'CONFLICT' });
  });

  it('sends a test message only for active links', async () => {
    const repository = new LinkRepositoryFake();
    const client = new ClientFake();
    repository.linkById = buildLink();
    const service = new TelegramLinkService(repository, client);

    await service.sendTestMessage(adminActor(), 'link-1');

    expect(client.messages[0]?.chatId).toBe('123');
    expect(client.messages[0]?.text).toContain('Vinculacion Telegram activa');
    expect(repository.auditEvents[0]?.action).toBe('TELEGRAM_TEST_MESSAGE_SENT');
  });
});

class LinkRepositoryFake implements ITelegramRepository {
  public existingByChatId: TelegramChatLink | null = null;
  public linkById: TelegramChatLink | null = null;
  public auditEvents: CreateTelegramAuditEventInput[] = [];

  public async findUserByEmailInTenant(tenantId: string, email: string): Promise<TelegramLinkedUser | null> {
    if (tenantId !== 'tenant-1' || email !== 'client@example.com') {
      return null;
    }

    return {
      id: 'user-1',
      tenantId,
      email,
      name: 'Client',
      role: 'CLIENT_VIEWER',
      status: 'ACTIVE',
    };
  }

  public async findLinksByTenant(_tenantId: string): Promise<TelegramChatLink[]> {
    return [];
  }

  public async findLinkById(_tenantId: string, _id: string): Promise<TelegramChatLink | null> {
    return this.linkById;
  }

  public async findActiveLinkByChatId(_chatId: string): Promise<TelegramChatLink | null> {
    return this.existingByChatId?.status === 'ACTIVE' ? this.existingByChatId : null;
  }

  public async findAnyLinkByChatId(_chatId: string): Promise<TelegramChatLink | null> {
    return this.existingByChatId;
  }

  public async createOrUpdateLink(input: CreateOrUpdateTelegramLinkInput): Promise<TelegramChatLink> {
    const link = buildLink({
      tenantId: input.tenantId,
      userId: input.userId,
      chatId: input.chatId,
      ...(input.telegramUsername !== undefined ? { telegramUsername: input.telegramUsername } : {}),
      ...(input.telegramUserId !== undefined ? { telegramUserId: input.telegramUserId } : {}),
      linkedByUserId: input.linkedByUserId,
    });
    this.linkById = link;
    return link;
  }

  public async disableLink(_tenantId: string, _id: string): Promise<TelegramChatLink | null> {
    if (this.linkById === null) {
      return null;
    }

    this.linkById = { ...this.linkById, status: 'DISABLED', disabledAt: new Date('2026-05-11T00:00:00.000Z') };
    return this.linkById;
  }

  public async createInteractionLog(_input: CreateTelegramInteractionLogInput): Promise<TelegramInteractionLog> {
    throw new Error('Not used');
  }

  public async createAuditEvent(input: CreateTelegramAuditEventInput): Promise<void> {
    this.auditEvents.push(input);
  }
}

class ClientFake implements ITelegramClient {
  public messages: { readonly chatId: string; readonly text: string }[] = [];

  public async sendMessage(input: { readonly chatId: string; readonly text: string }): Promise<void> {
    this.messages.push(input);
  }
}

function adminActor(): AuthContext {
  return {
    userId: 'admin-1',
    tenantId: 'tenant-1',
    email: 'admin@example.com',
    role: 'ADMIN',
    jwtId: 'jwt-1',
  };
}

function clientActor(): AuthContext {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    email: 'client@example.com',
    role: 'CLIENT_VIEWER',
    jwtId: 'jwt-2',
  };
}

function buildLink(overrides: Partial<TelegramChatLink> = {}): TelegramChatLink {
  return {
    id: 'link-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    chatId: '123',
    telegramUsername: 'client_user',
    status: 'ACTIVE',
    linkedByUserId: 'admin-1',
    createdAt: new Date('2026-05-11T00:00:00.000Z'),
    updatedAt: new Date('2026-05-11T00:00:00.000Z'),
    user: {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'client@example.com',
      name: 'Client',
      role: 'CLIENT_VIEWER',
      status: 'ACTIVE',
    },
    ...overrides,
  };
}

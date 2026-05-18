import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { ITelegramRepository } from '../../domain/interfaces/ITelegramRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { TelegramChatLink } from '../../domain/models/Telegram.js';
import type { ITelegramClient } from './TelegramClient.js';

export interface CreateTelegramLinkInput {
  readonly email: string;
  readonly chatId: string;
  readonly telegramUserId?: string;
  readonly telegramUsername?: string;
}

const adminRoles = new Set<AuthContext['role']>(['ADMIN', 'OPERATOR_ADMIN']);

export class TelegramLinkService {
  constructor(
    private readonly repository: ITelegramRepository,
    private readonly telegramClient: ITelegramClient,
  ) {}

  public async listLinks(actor: AuthContext): Promise<TelegramChatLink[]> {
    this.requireAdmin(actor);
    return this.repository.findLinksByTenant(actor.tenantId);
  }

  public async createLink(actor: AuthContext, input: CreateTelegramLinkInput): Promise<TelegramChatLink> {
    this.requireAdmin(actor);

    const email = input.email.trim().toLowerCase();
    const chatId = input.chatId.trim();

    if (email === '' || chatId === '') {
      throw new FinOpsBaseError('Email and chatId are required', 'VALIDATION_ERROR');
    }

    const user = await this.repository.findUserByEmailInTenant(actor.tenantId, email);

    if (user === null || user.status !== 'ACTIVE') {
      throw new FinOpsBaseError('User not found in current tenant or inactive', 'NOT_FOUND');
    }

    const existing = await this.repository.findAnyLinkByChatId(chatId);

    if (
      existing !== null &&
      existing.status === 'ACTIVE' &&
      (existing.tenantId !== actor.tenantId || existing.userId !== user.id)
    ) {
      throw new FinOpsBaseError('Telegram chat is already linked to another user or tenant', 'CONFLICT');
    }

    const link = await this.repository.createOrUpdateLink({
      tenantId: actor.tenantId,
      userId: user.id,
      chatId,
      ...(input.telegramUserId !== undefined && input.telegramUserId.trim() !== ''
        ? { telegramUserId: input.telegramUserId.trim() }
        : {}),
      ...(input.telegramUsername !== undefined && input.telegramUsername.trim() !== ''
        ? { telegramUsername: input.telegramUsername.trim().replace(/^@/, '') }
        : {}),
      linkedByUserId: actor.userId,
    });

    await this.repository.createAuditEvent({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'TELEGRAM_LINK_CREATED',
      entityType: 'TelegramChatLink',
      entityId: link.id,
      metadata: {
        chatId: link.chatId,
        userId: link.userId,
        email: user.email,
      },
    });

    return link;
  }

  public async disableLink(actor: AuthContext, linkId: string): Promise<TelegramChatLink> {
    this.requireAdmin(actor);

    const link = await this.repository.disableLink(actor.tenantId, linkId);

    if (link === null) {
      throw new FinOpsBaseError('Telegram link not found', 'NOT_FOUND');
    }

    await this.repository.createAuditEvent({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'TELEGRAM_LINK_DISABLED',
      entityType: 'TelegramChatLink',
      entityId: link.id,
      metadata: {
        chatId: link.chatId,
        userId: link.userId,
      },
    });

    return link;
  }

  public async sendTestMessage(actor: AuthContext, linkId: string): Promise<TelegramChatLink> {
    this.requireAdmin(actor);

    const link = await this.repository.findLinkById(actor.tenantId, linkId);

    if (link === null) {
      throw new FinOpsBaseError('Telegram link not found', 'NOT_FOUND');
    }

    if (link.status !== 'ACTIVE') {
      throw new FinOpsBaseError('Telegram link is disabled', 'VALIDATION_ERROR');
    }

    await this.telegramClient.sendMessage({
      chatId: link.chatId,
      text: [
        'Vinculacion Telegram activa.',
        `Usuario FinOps: ${link.user?.email ?? link.userId}`,
        'Ya puedes usar /ayuda para ver comandos disponibles.',
      ].join('\n'),
    });

    await this.repository.createAuditEvent({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'TELEGRAM_TEST_MESSAGE_SENT',
      entityType: 'TelegramChatLink',
      entityId: link.id,
      metadata: {
        chatId: link.chatId,
        userId: link.userId,
      },
    });

    return link;
  }

  private requireAdmin(actor: AuthContext): void {
    if (!adminRoles.has(actor.role)) {
      throw new AuthorizationError();
    }
  }
}

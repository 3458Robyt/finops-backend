import type { TelegramChatLink, TelegramInteractionLog, TelegramInteractionStatus, TelegramLinkedUser } from '../models/Telegram.js';

export interface CreateOrUpdateTelegramLinkInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly telegramUserId?: string;
  readonly telegramUsername?: string;
  readonly linkedByUserId: string;
}

export interface CreateTelegramInteractionLogInput {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly chatId: string;
  readonly telegramUserId?: string;
  readonly telegramUsername?: string;
  readonly command?: string;
  readonly status: TelegramInteractionStatus;
  readonly textPreview?: string;
  readonly errorMessage?: string;
  readonly metadata?: unknown;
}

export interface CreateTelegramAuditEventInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly metadata?: unknown;
}

export interface ITelegramRepository {
  findUserByEmailInTenant(tenantId: string, email: string): Promise<TelegramLinkedUser | null>;
  findLinksByTenant(tenantId: string): Promise<TelegramChatLink[]>;
  findLinkById(tenantId: string, id: string): Promise<TelegramChatLink | null>;
  findActiveLinkByChatId(chatId: string): Promise<TelegramChatLink | null>;
  findAnyLinkByChatId(chatId: string): Promise<TelegramChatLink | null>;
  createOrUpdateLink(input: CreateOrUpdateTelegramLinkInput): Promise<TelegramChatLink>;
  disableLink(tenantId: string, id: string): Promise<TelegramChatLink | null>;
  createInteractionLog(input: CreateTelegramInteractionLogInput): Promise<TelegramInteractionLog>;
  createAuditEvent(input: CreateTelegramAuditEventInput): Promise<void>;
}

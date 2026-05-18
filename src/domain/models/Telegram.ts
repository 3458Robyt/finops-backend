import type { UserRole } from './AuthContext.js';

export type TelegramChatLinkStatus = 'ACTIVE' | 'DISABLED';
export type TelegramInteractionStatus = 'PROCESSED' | 'IGNORED' | 'ERROR';

export interface TelegramLinkedUser {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly status: 'ACTIVE' | 'DISABLED';
}

export interface TelegramChatLink {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly telegramUserId?: string;
  readonly telegramUsername?: string;
  readonly status: TelegramChatLinkStatus;
  readonly linkedByUserId: string;
  readonly disabledAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly user?: TelegramLinkedUser;
}

export interface TelegramInteractionLog {
  readonly id: string;
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
  readonly createdAt: Date;
}

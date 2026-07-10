import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { ITelegramRepository } from '../../domain/interfaces/ITelegramRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { OutboundMessageChannel, OutboundMessageDelivery, OutboundMessageType } from '../../domain/models/OutboundMessage.js';
import type { TelegramChatLink } from '../../domain/models/Telegram.js';
import type { IEmailClient } from './EmailClient.js';
import type { SavingsReminderService } from './SavingsReminderService.js';
import type { ITelegramClient } from './TelegramClient.js';
import { formatRecommendations, formatSavingsReminders } from './telegram/telegramMessageFormatters.js';

const adminRoles = new Set<AuthContext['role']>(['ADMIN', 'MASTER_ADMIN', 'OPERATOR_ADMIN']);

export interface OutboundChannelStatus {
  readonly telegram: {
    readonly enabled: boolean;
    readonly botUsernameConfigured: boolean;
    readonly webhookSecretConfigured: boolean;
    readonly activeLinks: number;
    readonly totalLinks: number;
  };
  readonly email: {
    readonly enabled: boolean;
    readonly smtpConfigured: boolean;
  };
}

export interface SendTestMessagesResult {
  readonly deliveries: readonly OutboundMessageDelivery[];
}

export interface SendSavingsRemindersResult {
  readonly deliveries: readonly OutboundMessageDelivery[];
  readonly attemptedUsers: number;
}

export class OutboundMessageService {
  constructor(
    private readonly outboundRepository: IOutboundMessageRepository,
    private readonly telegramRepository: ITelegramRepository,
    private readonly telegramClient: ITelegramClient,
    private readonly emailClient: IEmailClient,
    private readonly savingsReminderService: SavingsReminderService,
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly config: {
      readonly telegramEnabled: boolean;
      readonly telegramBotUsername?: string;
      readonly telegramWebhookSecret?: string;
    },
  ) {}

  public async getStatus(actor: AuthContext): Promise<OutboundChannelStatus> {
    this.requireAdmin(actor);
    const links = await this.telegramRepository.findLinksByTenant(actor.tenantId);
    return {
      telegram: {
        enabled: this.config.telegramEnabled,
        botUsernameConfigured: this.config.telegramBotUsername !== undefined && this.config.telegramBotUsername.trim() !== '',
        webhookSecretConfigured: this.config.telegramWebhookSecret !== undefined && this.config.telegramWebhookSecret.trim() !== '',
        activeLinks: links.filter((link) => link.status === 'ACTIVE').length,
        totalLinks: links.length,
      },
      email: {
        enabled: this.emailClient.enabled,
        smtpConfigured: this.emailClient.enabled,
      },
    };
  }

  public async listRecentDeliveries(actor: AuthContext, limit: number): Promise<readonly OutboundMessageDelivery[]> {
    this.requireAdmin(actor);
    return this.outboundRepository.listRecent({ tenantId: actor.tenantId, limit });
  }

  public async sendTestMessages(actor: AuthContext, input: { readonly email?: string; readonly telegramLinkId?: string }): Promise<SendTestMessagesResult> {
    this.requireAdmin(actor);
    const deliveries: OutboundMessageDelivery[] = [];
    const text = [
      'Mensaje de prueba de FinOps Inteligente.',
      '',
      'Los canales externos estan configurados para enviar alertas y respuestas del agente IA en espanol.',
    ].join('\n');

    if (input.email !== undefined && input.email.trim() !== '') {
      deliveries.push(await this.sendEmail({
        tenantId: actor.tenantId,
        userId: actor.userId,
        to: input.email.trim(),
        subject: 'Prueba de correo FinOps Inteligente',
        text,
        messageType: 'TEST',
      }));
    }

    if (input.telegramLinkId !== undefined && input.telegramLinkId.trim() !== '') {
      const link = await this.telegramRepository.findLinkById(actor.tenantId, input.telegramLinkId.trim());
      if (link === null || link.status !== 'ACTIVE') {
        throw new FinOpsBaseError('Telegram link not found or inactive', 'NOT_FOUND');
      }
      deliveries.push(await this.sendTelegram({
        tenantId: actor.tenantId,
        userId: link.userId,
        chatId: link.chatId,
        text,
        messageType: 'TEST',
      }));
    }

    if (deliveries.length === 0) {
      throw new FinOpsBaseError('At least one channel target is required', 'VALIDATION_ERROR');
    }

    return { deliveries };
  }

  public async sendSavingsReminders(actor: AuthContext): Promise<SendSavingsRemindersResult> {
    this.requireAdmin(actor);
    const users = await this.outboundRepository.findTenantUsers(actor.tenantId);
    const links = await this.telegramRepository.findLinksByTenant(actor.tenantId);
    const activeLinksByUserId = new Map(links.filter((link) => link.status === 'ACTIVE').map((link) => [link.userId, link]));
    const deliveries: OutboundMessageDelivery[] = [];

    for (const user of users.filter((item) => item.status === 'ACTIVE')) {
      const reminders = await this.savingsReminderService.getNotificationsForUser({
        tenantId: actor.tenantId,
        userId: user.id,
      });
      const text = formatSavingsReminders(reminders.notifications);
      if (reminders.notifications.length === 0) {
        continue;
      }

      const link = activeLinksByUserId.get(user.id);
      if (link !== undefined) {
        deliveries.push(await this.sendTelegram({
          tenantId: actor.tenantId,
          userId: user.id,
          chatId: link.chatId,
          text,
          messageType: 'SAVINGS_REMINDER',
        }));
      }

      deliveries.push(await this.sendEmail({
        tenantId: actor.tenantId,
        userId: user.id,
        to: user.email,
        subject: 'Recordatorios de ahorro FinOps',
        text,
        messageType: 'SAVINGS_REMINDER',
      }));
    }

    return { deliveries, attemptedUsers: users.filter((item) => item.status === 'ACTIVE').length };
  }

  public async sendAiResponseToUser(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly text: string;
    readonly subject?: string;
    readonly channels: readonly OutboundMessageChannel[];
  }): Promise<readonly OutboundMessageDelivery[]> {
    const user = (await this.outboundRepository.findTenantUsers(input.tenantId)).find((item) => item.id === input.userId);
    if (user === undefined || user.status !== 'ACTIVE') {
      throw new FinOpsBaseError('User not found or inactive', 'NOT_FOUND');
    }
    const links = await this.telegramRepository.findLinksByTenant(input.tenantId);
    const link = links.find((item) => item.userId === input.userId && item.status === 'ACTIVE');
    const deliveries: OutboundMessageDelivery[] = [];

    if (input.channels.includes('EMAIL')) {
      deliveries.push(await this.sendEmail({
        tenantId: input.tenantId,
        userId: input.userId,
        to: user.email,
        subject: input.subject ?? 'Respuesta del agente FinOps IA',
        text: input.text,
        messageType: 'AI_CHAT_RESPONSE',
      }));
    }

    if (input.channels.includes('TELEGRAM') && link !== undefined) {
      deliveries.push(await this.sendTelegram({
        tenantId: input.tenantId,
        userId: input.userId,
        chatId: link.chatId,
        text: input.text,
        messageType: 'AI_CHAT_RESPONSE',
      }));
    }

    return deliveries;
  }

  public async sendRecommendationSummary(actor: AuthContext): Promise<SendTestMessagesResult> {
    this.requireAdmin(actor);
    const recommendations = await this.recommendationRepository.findByTenant({ tenantId: actor.tenantId });
    const text = formatRecommendations(recommendations);
    const users = await this.outboundRepository.findTenantUsers(actor.tenantId);
    const links = await this.telegramRepository.findLinksByTenant(actor.tenantId);
    const deliveries: OutboundMessageDelivery[] = [];

    for (const user of users.filter((item) => item.status === 'ACTIVE')) {
      const link = links.find((item) => item.userId === user.id && item.status === 'ACTIVE');
      if (link !== undefined) {
        deliveries.push(await this.sendTelegram({
          tenantId: actor.tenantId,
          userId: user.id,
          chatId: link.chatId,
          text,
          messageType: 'RECOMMENDATION_SUMMARY',
        }));
      }
      deliveries.push(await this.sendEmail({
        tenantId: actor.tenantId,
        userId: user.id,
        to: user.email,
        subject: 'Resumen de recomendaciones FinOps',
        text,
        messageType: 'RECOMMENDATION_SUMMARY',
      }));
    }

    return { deliveries };
  }

  private async sendTelegram(input: {
    readonly tenantId: string;
    readonly userId?: string;
    readonly chatId: string;
    readonly text: string;
    readonly messageType: OutboundMessageType;
  }): Promise<OutboundMessageDelivery> {
    if (!this.config.telegramEnabled) {
      return this.outboundRepository.create({
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        channel: 'TELEGRAM',
        messageType: input.messageType,
        status: 'SKIPPED',
        preview: truncatePreview(input.text),
        errorMessage: 'Telegram channel disabled',
      });
    }

    try {
      await this.telegramClient.sendMessage({ chatId: input.chatId, text: input.text });
      return this.outboundRepository.create({
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        channel: 'TELEGRAM',
        messageType: input.messageType,
        status: 'SENT',
        preview: truncatePreview(input.text),
        sentAt: new Date(),
        metadata: { chatId: input.chatId },
      });
    } catch (error: unknown) {
      return this.outboundRepository.create({
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        channel: 'TELEGRAM',
        messageType: input.messageType,
        status: 'FAILED',
        preview: truncatePreview(input.text),
        errorMessage: error instanceof Error ? error.message : 'Telegram delivery failed',
        metadata: { chatId: input.chatId },
      });
    }
  }

  private async sendEmail(input: {
    readonly tenantId: string;
    readonly userId?: string;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly messageType: OutboundMessageType;
  }): Promise<OutboundMessageDelivery> {
    if (!this.emailClient.enabled) {
      return this.outboundRepository.create({
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        channel: 'EMAIL',
        messageType: input.messageType,
        status: 'SKIPPED',
        subject: input.subject,
        preview: truncatePreview(input.text),
        errorMessage: 'Email channel disabled',
        metadata: { to: input.to },
      });
    }

    try {
      const result = await this.emailClient.send({ to: input.to, subject: input.subject, text: input.text });
      return this.outboundRepository.create({
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        channel: 'EMAIL',
        messageType: input.messageType,
        status: 'SENT',
        subject: input.subject,
        preview: truncatePreview(input.text),
        ...(result.messageId !== undefined ? { providerMessageId: result.messageId } : {}),
        sentAt: new Date(),
        metadata: { to: input.to },
      });
    } catch (error: unknown) {
      return this.outboundRepository.create({
        tenantId: input.tenantId,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        channel: 'EMAIL',
        messageType: input.messageType,
        status: 'FAILED',
        subject: input.subject,
        preview: truncatePreview(input.text),
        errorMessage: error instanceof Error ? error.message : 'Email delivery failed',
        metadata: { to: input.to },
      });
    }
  }

  private requireAdmin(actor: AuthContext): void {
    if (!adminRoles.has(actor.role)) {
      throw new AuthorizationError('Only agent administrators can manage outbound messages');
    }
  }
}

function truncatePreview(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

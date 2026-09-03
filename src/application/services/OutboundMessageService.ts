import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { ITelegramRepository } from '../../domain/interfaces/ITelegramRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { OutboundMessageChannel, OutboundMessageDelivery } from '../../domain/models/OutboundMessage.js';
import type { TelegramChatLink } from '../../domain/models/Telegram.js';
import type { IEmailClient } from './EmailClient.js';
import type { SavingsReminderService } from './SavingsReminderService.js';
import type { ITelegramClient } from './TelegramClient.js';
import {
  OutboundMessageDeliveryProcessor,
  type ProcessPendingOutboundDeliveryInput,
  type ProcessPendingOutboundDeliveryResult,
} from './OutboundMessageDeliveryProcessor.js';
import { OutboundChannelDeliveryService } from './OutboundChannelDeliveryService.js';
import { formatRecommendations, formatSavingsReminders } from './telegram/telegramMessageFormatters.js';
import type { ExecutiveSummaryDeliveryService } from './ExecutiveSummaryDeliveryService.js';
import type { MessagingPreferenceService } from './MessagingPreferenceService.js';
import { requirePermission } from '../../domain/security/AuthorizationPolicy.js';

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

export interface ValueRealizationOutboundInput {
  readonly recommendationId: string;
  readonly measurementId: string;
  readonly status: string;
  readonly currency: string;
  readonly observationStart: Date;
  readonly observationEnd: Date;
}

export class OutboundMessageService {
  private readonly deliveryProcessor: OutboundMessageDeliveryProcessor;
  private readonly channelDelivery: OutboundChannelDeliveryService;

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
    private readonly executiveSummaryDeliveryService: ExecutiveSummaryDeliveryService | undefined = undefined,
    private readonly messagingPreferenceService: MessagingPreferenceService | undefined = undefined,
  ) {
    this.deliveryProcessor = new OutboundMessageDeliveryProcessor(
      outboundRepository,
      telegramClient,
      emailClient,
      config.telegramEnabled,
    );
    this.channelDelivery = new OutboundChannelDeliveryService(
      outboundRepository,
      telegramClient,
      emailClient,
      { telegramEnabled: config.telegramEnabled },
    );
  }

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

  public requireConfigurationAdmin(actor: AuthContext): void {
    this.requireAdmin(actor);
  }

  public async verifyEmailConfiguration(): Promise<boolean> {
    if (!this.emailClient.enabled) {
      throw new FinOpsBaseError('El correo SMTP está deshabilitado', 'EMAIL_DISABLED');
    }
    if (this.emailClient.verify === undefined) {
      throw new FinOpsBaseError('El cliente SMTP no admite verificación', 'CONFIGURATION_ERROR');
    }
    await this.emailClient.verify();
    return true;
  }

  public async verifyTelegramConfiguration(): Promise<boolean> {
    this.requireTelegramEnabled();
    if (this.telegramClient.verify === undefined) {
      throw new FinOpsBaseError('El cliente de Telegram no admite verificación', 'CONFIGURATION_ERROR');
    }
    await this.telegramClient.verify();
    return true;
  }

  public processNextPendingDelivery(
    input: ProcessPendingOutboundDeliveryInput,
  ): Promise<ProcessPendingOutboundDeliveryResult> {
    return this.deliveryProcessor.processNext(input);
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
      deliveries.push(await this.channelDelivery.sendEmail({
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
      deliveries.push(await this.channelDelivery.sendTelegram({
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
        if (await this.allows(user.id, 'TELEGRAM', 'financial')) deliveries.push(await this.channelDelivery.sendTelegram({
          tenantId: actor.tenantId,
          userId: user.id,
          chatId: link.chatId,
          text,
          messageType: 'SAVINGS_REMINDER',
        }));
      }

      if (await this.allows(user.id, 'EMAIL', 'financial')) deliveries.push(await this.channelDelivery.sendEmail({
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

  public async sendValueRealizationUpdate(tenantId: string, input: ValueRealizationOutboundInput): Promise<void> {
    const users = await this.outboundRepository.findTenantUsers(tenantId);
    const links = await this.telegramRepository.findLinksByTenant(tenantId);
    const activeLinksByUserId = new Map(links.filter((link) => link.status === 'ACTIVE').map((link) => [link.userId, link]));
    const text = input.status === 'CALCULATED'
      ? `La medición determinística de ahorro ya está disponible para revisión. Recomendación: ${input.recommendationId}. Moneda: ${input.currency}. Periodo observado: ${input.observationStart.toISOString().slice(0, 10)} a ${input.observationEnd.toISOString().slice(0, 10)}.`
      : `La medición posterior a la ejecución fue actualizada. Recomendación: ${input.recommendationId}. Estado: ${input.status.toLowerCase()}. Moneda: ${input.currency}.`;
    for (const user of users.filter((item) => item.status === 'ACTIVE')) {
      const link = activeLinksByUserId.get(user.id);
      if (link !== undefined && await this.allows(user.id, 'TELEGRAM', 'financial')) await this.channelDelivery.sendTelegram({ tenantId, userId: user.id, chatId: link.chatId, text, messageType: 'SAVINGS_REMINDER' });
      if (await this.allows(user.id, 'EMAIL', 'financial')) await this.channelDelivery.sendEmail({ tenantId, userId: user.id, to: user.email, subject: 'Actualización de valor realizado FinOps', text, messageType: 'SAVINGS_REMINDER' });
    }
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

    if (input.channels.includes('EMAIL') && await this.allows(input.userId, 'EMAIL', 'operational')) {
      deliveries.push(await this.channelDelivery.sendEmail({
        tenantId: input.tenantId,
        userId: input.userId,
        to: user.email,
        subject: input.subject ?? 'Respuesta del agente FinOps IA',
        text: input.text,
        messageType: 'AI_CHAT_RESPONSE',
      }));
    }

    if (input.channels.includes('TELEGRAM') && link !== undefined && await this.allows(input.userId, 'TELEGRAM', 'operational')) {
      deliveries.push(await this.channelDelivery.sendTelegram({
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
      if (link !== undefined && await this.allows(user.id, 'TELEGRAM', 'recommendations')) {
        deliveries.push(await this.channelDelivery.sendTelegram({
          tenantId: actor.tenantId,
          userId: user.id,
          chatId: link.chatId,
          text,
          messageType: 'RECOMMENDATION_SUMMARY',
        }));
      }
      if (await this.allows(user.id, 'EMAIL', 'recommendations')) deliveries.push(await this.channelDelivery.sendEmail({
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

  /** Envía un resumen ejecutivo diario; las claves de deduplicación evitan spam al reiniciar el scheduler. */
  public async sendExecutiveSummary(actor: AuthContext): Promise<SendTestMessagesResult> {
    this.requireAdmin(actor);
    if (this.executiveSummaryDeliveryService === undefined) {
      throw new FinOpsBaseError('El resumen ejecutivo no está configurado', 'CONFIGURATION_ERROR');
    }
    return { deliveries: await this.executiveSummaryDeliveryService.send(actor.tenantId) };
  }

  public async sendExecutiveSummaryIfConfigured(actor: AuthContext): Promise<SendTestMessagesResult | null> {
    if (this.executiveSummaryDeliveryService === undefined) return null;
    return this.sendExecutiveSummary(actor);
  }

  private requireAdmin(actor: AuthContext): void {
    requirePermission(actor.role, 'OUTBOUND_MANAGE', 'Solo los administradores del agente pueden gestionar mensajes externos');
  }

  private requireTelegramEnabled(): void {
    if (!this.config.telegramEnabled) {
      throw new FinOpsBaseError('Telegram está deshabilitado', 'TELEGRAM_DISABLED');
    }
  }

  private async allows(userId: string, channel: 'EMAIL' | 'TELEGRAM', category: 'operational' | 'recommendations' | 'financial' | 'executive'): Promise<boolean> {
    return this.messagingPreferenceService === undefined
      ? true
      : this.messagingPreferenceService.allows(userId, channel, category);
  }

}

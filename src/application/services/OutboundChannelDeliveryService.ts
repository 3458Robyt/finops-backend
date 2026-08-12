import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { OutboundMessageDelivery, OutboundMessageType } from '../../domain/models/OutboundMessage.js';
import { safeErrorMessage } from '../observability/safeError.js';
import type { IEmailClient } from './EmailClient.js';
import type { ITelegramClient } from './TelegramClient.js';

export interface OutboundChannelDeliveryConfig {
  readonly telegramEnabled: boolean;
}

export interface SendTelegramDeliveryInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly chatId: string;
  readonly text: string;
  readonly messageType: OutboundMessageType;
}

export interface SendEmailDeliveryInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly messageType: OutboundMessageType;
}

/** Persiste el resultado de cada envío y mantiene los canales externos aislados del orquestador. */
export class OutboundChannelDeliveryService {
  constructor(
    private readonly outboundRepository: IOutboundMessageRepository,
    private readonly telegramClient: ITelegramClient,
    private readonly emailClient: IEmailClient,
    private readonly config: OutboundChannelDeliveryConfig,
  ) {}

  public async sendTelegram(input: SendTelegramDeliveryInput): Promise<OutboundMessageDelivery> {
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
        errorMessage: safeErrorMessage(error),
        metadata: { chatId: input.chatId },
      });
    }
  }

  public async sendEmail(input: SendEmailDeliveryInput): Promise<OutboundMessageDelivery> {
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
        errorMessage: safeErrorMessage(error),
        metadata: { to: input.to },
      });
    }
  }
}

export function truncatePreview(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

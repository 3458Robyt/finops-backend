import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { OutboundMessageDelivery, OutboundMessageType } from '../../domain/models/OutboundMessage.js';
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
  private readonly emailEnabled: boolean;

  constructor(
    private readonly outboundRepository: IOutboundMessageRepository,
    _telegramClient: ITelegramClient,
    emailClient: IEmailClient,
    private readonly config: OutboundChannelDeliveryConfig,
  ) {
    this.emailEnabled = emailClient.enabled;
  }

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

    return this.outboundRepository.create({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      channel: 'TELEGRAM',
      messageType: input.messageType,
      status: 'PENDING',
      preview: truncatePreview(input.text),
      body: fitTelegramMessage(input.text),
      maxAttempts: 3,
      metadata: { chatId: input.chatId },
    });
  }

  public async sendEmail(input: SendEmailDeliveryInput): Promise<OutboundMessageDelivery> {
    if (!this.emailEnabled) {
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

    return this.outboundRepository.create({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      channel: 'EMAIL',
      messageType: input.messageType,
      status: 'PENDING',
      subject: input.subject,
      preview: truncatePreview(input.text),
      body: input.text,
      maxAttempts: 3,
      metadata: { to: input.to },
    });
  }
}

export function truncatePreview(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

function fitTelegramMessage(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 3900
    ? normalized
    : `${normalized.slice(0, 3860).trimEnd()}\n\n[Mensaje recortado. Consulta el detalle completo en FinOps.]`;
}

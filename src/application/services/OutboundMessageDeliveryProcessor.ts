import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { OutboundMessageDelivery } from '../../domain/models/OutboundMessage.js';
import { safeErrorMessage } from '../observability/safeError.js';
import type { IEmailClient } from './EmailClient.js';
import type { ITelegramClient } from './TelegramClient.js';

export interface ProcessPendingOutboundDeliveryInput {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly retryBackoffMs: number;
}

export interface ProcessPendingOutboundDeliveryResult {
  readonly processed: boolean;
  readonly delivery?: OutboundMessageDelivery;
}

export class OutboundMessageDeliveryProcessor {
  constructor(
    private readonly repository: IOutboundMessageRepository,
    private readonly telegramClient: ITelegramClient,
    private readonly emailClient: IEmailClient,
    private readonly telegramEnabled: boolean,
  ) {}

  public async processNext(
    input: ProcessPendingOutboundDeliveryInput,
  ): Promise<ProcessPendingOutboundDeliveryResult> {
    const claimed = await this.repository.claimNextPending({
      workerId: input.workerId,
      leaseExpiredBefore: new Date(Date.now() - Math.max(1_000, input.leaseMs)),
    });
    if (claimed === null) return { processed: false };

    const { delivery, body, attempts, maxAttempts } = claimed;
    const metadata = asMetadata(delivery.metadata);
    const recipient = delivery.channel === 'EMAIL' ? metadata.to : metadata.chatId;
    if (recipient === undefined || recipient.trim() === '') {
      return this.complete(delivery, input.workerId, {
        status: 'FAILED',
        errorMessage: 'La entrega no tiene un destinatario válido.',
      });
    }

    if (delivery.channel === 'EMAIL' && !this.emailClient.enabled) {
      return this.complete(delivery, input.workerId, {
        status: 'SKIPPED',
        errorMessage: 'Canal de correo deshabilitado.',
      });
    }
    if (delivery.channel === 'TELEGRAM' && !this.telegramEnabled) {
      return this.complete(delivery, input.workerId, {
        status: 'SKIPPED',
        errorMessage: 'Canal de Telegram deshabilitado.',
      });
    }
    if (delivery.channel === 'TELEGRAM' && metadata.chatId === undefined) {
      return this.complete(delivery, input.workerId, {
        status: 'FAILED',
        errorMessage: 'La entrega de Telegram no tiene chat configurado.',
      });
    }

    try {
      const providerMessageId = delivery.channel === 'EMAIL'
        ? (await this.emailClient.send({ to: recipient, subject: delivery.subject ?? 'Notificación FinOps', text: body })).messageId
        : await this.sendTelegram(recipient, body);
      return this.complete(delivery, input.workerId, {
        status: 'SENT',
        ...(providerMessageId === undefined ? {} : { providerMessageId }),
      });
    } catch (error: unknown) {
      const retryable = attempts < maxAttempts;
      return this.complete(delivery, input.workerId, {
        status: retryable ? 'PENDING' : 'FAILED',
        errorMessage: safeErrorMessage(error),
        ...(retryable
          ? { nextAttemptAt: new Date(Date.now() + retryDelay(input.retryBackoffMs, attempts)) }
          : {}),
      });
    }
  }

  private async sendTelegram(chatId: string, text: string): Promise<undefined> {
    await this.telegramClient.sendMessage({ chatId, text });
    return undefined;
  }

  private async complete(
    delivery: OutboundMessageDelivery,
    workerId: string,
    input: {
      readonly status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
      readonly errorMessage?: string;
      readonly providerMessageId?: string;
      readonly nextAttemptAt?: Date;
    },
  ): Promise<ProcessPendingOutboundDeliveryResult> {
    const completed = await this.repository.completeClaimed({ id: delivery.id, workerId, ...input });
    return { processed: true, ...(completed === null ? {} : { delivery: completed }) };
  }
}

function asMetadata(value: unknown): { readonly to?: string; readonly chatId?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  return {
    ...(typeof metadata['to'] === 'string' ? { to: metadata['to'] } : {}),
    ...(typeof metadata['chatId'] === 'string' ? { chatId: metadata['chatId'] } : {}),
  };
}

function retryDelay(baseMs: number, attempts: number): number {
  const base = Math.max(1_000, baseMs);
  return Math.min(base * (2 ** Math.max(0, attempts - 1)), 60 * 60 * 1000);
}

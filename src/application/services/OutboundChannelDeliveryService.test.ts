import { describe, expect, it, vi } from 'vitest';
import type { CreateOutboundMessageDeliveryInput, IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { OutboundMessageDelivery } from '../../domain/models/OutboundMessage.js';
import type { IEmailClient } from './EmailClient.js';
import { OutboundChannelDeliveryService } from './OutboundChannelDeliveryService.js';
import type { ITelegramClient } from './TelegramClient.js';

describe('OutboundChannelDeliveryService', () => {
  it('persists a skipped Telegram delivery without calling the provider', async () => {
    const repository = deliveryRepository();
    const telegram = { sendMessage: vi.fn(async () => undefined) } satisfies ITelegramClient;
    const email = { enabled: false, send: vi.fn() } satisfies IEmailClient;
    const service = new OutboundChannelDeliveryService(repository, telegram, email, { telegramEnabled: false });

    const result = await service.sendTelegram({
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      text: 'Mensaje',
      messageType: 'TEST',
    });

    expect(result).toMatchObject({ channel: 'TELEGRAM', status: 'SKIPPED', errorMessage: 'Telegram channel disabled' });
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('persists a successful email with the provider message id', async () => {
    const repository = deliveryRepository();
    const telegram = { sendMessage: vi.fn(async () => undefined) } satisfies ITelegramClient;
    const email = { enabled: true, send: vi.fn(async () => ({ messageId: 'provider-1' })) } satisfies IEmailClient;
    const service = new OutboundChannelDeliveryService(repository, telegram, email, { telegramEnabled: true });

    const result = await service.sendEmail({
      tenantId: 'tenant-1',
      userId: 'user-1',
      to: 'user@example.com',
      subject: 'Prueba',
      text: 'Mensaje',
      messageType: 'TEST',
    });

    expect(result).toMatchObject({ channel: 'EMAIL', status: 'SENT', providerMessageId: 'provider-1' });
    expect(email.send).toHaveBeenCalledWith({ to: 'user@example.com', subject: 'Prueba', text: 'Mensaje' });
  });

  it('persists a failed Telegram delivery without propagating provider errors', async () => {
    const repository = deliveryRepository();
    const telegram = { sendMessage: vi.fn(async () => { throw new Error('provider unavailable'); }) } satisfies ITelegramClient;
    const email = { enabled: false, send: vi.fn() } satisfies IEmailClient;
    const service = new OutboundChannelDeliveryService(repository, telegram, email, { telegramEnabled: true });

    const result = await service.sendTelegram({
      tenantId: 'tenant-1',
      chatId: 'chat-1',
      text: 'Mensaje',
      messageType: 'TEST',
    });

    expect(result).toMatchObject({ channel: 'TELEGRAM', status: 'FAILED', errorMessage: 'provider unavailable' });
  });
});

function deliveryRepository(): IOutboundMessageRepository {
  const create = async (input: CreateOutboundMessageDeliveryInput): Promise<OutboundMessageDelivery> => {
    const now = new Date('2026-08-12T12:00:00.000Z');
    return {
      id: 'delivery-1',
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.recommendationId !== undefined ? { recommendationId: input.recommendationId } : {}),
      channel: input.channel,
      messageType: input.messageType,
      status: input.status ?? 'PENDING',
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      preview: input.preview,
      ...(input.providerMessageId !== undefined ? { providerMessageId: input.providerMessageId } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
      createdAt: now,
      updatedAt: now,
    };
  };

  return {
    create,
    listRecent: async () => [],
    claimNextPending: async () => null,
    completeClaimed: async () => null,
    findTenantUsers: async () => [],
  };
}

import { describe, expect, it, vi } from 'vitest';
import type {
  ClaimedOutboundMessageDelivery,
  CompleteOutboundMessageDeliveryInput,
  CreateOutboundMessageDeliveryInput,
  IOutboundMessageRepository,
} from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { OutboundMessageDelivery } from '../../domain/models/OutboundMessage.js';
import { OutboundMessageDeliveryProcessor } from './OutboundMessageDeliveryProcessor.js';
import type { IEmailClient } from './EmailClient.js';
import type { ITelegramClient } from './TelegramClient.js';

describe('OutboundMessageDeliveryProcessor', () => {
  it('delivers a queued email and marks it as sent', async () => {
    const repository = new FakeOutboundRepository(queuedDelivery('EMAIL', { to: 'user@example.com' }));
    const email = { enabled: true, send: vi.fn(async () => ({ messageId: 'provider-1' })) } satisfies IEmailClient;
    const telegram = { sendMessage: vi.fn(async () => undefined) } satisfies ITelegramClient;
    const processor = new OutboundMessageDeliveryProcessor(repository, telegram, email, true);

    const result = await processor.processNext({ workerId: 'scheduler-1', leaseMs: 60_000, retryBackoffMs: 1_000 });

    expect(result.processed).toBe(true);
    expect(email.send).toHaveBeenCalledWith({ to: 'user@example.com', subject: 'Alerta', text: 'Mensaje completo' });
    expect(repository.completed[0]).toMatchObject({ id: 'delivery-1', workerId: 'scheduler-1', status: 'SENT', providerMessageId: 'provider-1' });
  });

  it('skips a queued email when SMTP is disabled', async () => {
    const repository = new FakeOutboundRepository(queuedDelivery('EMAIL', { to: 'user@example.com' }));
    const email = { enabled: false, send: vi.fn() } satisfies IEmailClient;
    const processor = new OutboundMessageDeliveryProcessor(repository, { sendMessage: vi.fn() }, email, true);

    await processor.processNext({ workerId: 'scheduler-1', leaseMs: 60_000, retryBackoffMs: 1_000 });

    expect(email.send).not.toHaveBeenCalled();
    expect(repository.completed[0]).toMatchObject({ status: 'SKIPPED', errorMessage: 'Canal de correo deshabilitado.' });
  });

  it('requeues a failed Telegram delivery while attempts remain', async () => {
    const repository = new FakeOutboundRepository(queuedDelivery('TELEGRAM', { chatId: 'chat-1' }, 1, 3));
    const telegram = { sendMessage: vi.fn(async () => { throw new Error('provider unavailable'); }) } satisfies ITelegramClient;
    const processor = new OutboundMessageDeliveryProcessor(repository, telegram, { enabled: false, send: vi.fn() }, true);

    await processor.processNext({ workerId: 'scheduler-1', leaseMs: 60_000, retryBackoffMs: 1_000 });

    expect(telegram.sendMessage).toHaveBeenCalledWith({ chatId: 'chat-1', text: 'Mensaje completo' });
    expect(repository.completed[0]?.status).toBe('PENDING');
    expect(repository.completed[0]?.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('fails a queued delivery without a destination instead of retrying forever', async () => {
    const repository = new FakeOutboundRepository(queuedDelivery('EMAIL', {}));
    const processor = new OutboundMessageDeliveryProcessor(repository, { sendMessage: vi.fn() }, { enabled: true, send: vi.fn() }, true);

    await processor.processNext({ workerId: 'scheduler-1', leaseMs: 60_000, retryBackoffMs: 1_000 });

    expect(repository.completed[0]).toMatchObject({ status: 'FAILED', errorMessage: 'La entrega no tiene un destinatario válido.' });
  });
});

class FakeOutboundRepository implements IOutboundMessageRepository {
  public readonly completed: Array<Record<string, unknown>> = [];
  public constructor(private readonly queued: ClaimedOutboundMessageDelivery | null) {}
  public async create(_input: CreateOutboundMessageDeliveryInput): Promise<OutboundMessageDelivery> { return this.queued!.delivery; }
  public async listRecent(): Promise<readonly OutboundMessageDelivery[]> { return []; }
  public async claimNextPending(): Promise<ClaimedOutboundMessageDelivery | null> { return this.queued; }
  public async completeClaimed(input: CompleteOutboundMessageDeliveryInput): Promise<OutboundMessageDelivery | null> {
    this.completed.push(input);
    return this.queued?.delivery ?? null;
  }
  public async findTenantUsers(): Promise<readonly { id: string; email: string; name: string; status: 'ACTIVE' | 'DISABLED' }[]> { return []; }
}

function queuedDelivery(
  channel: 'EMAIL' | 'TELEGRAM',
  metadata: Record<string, string>,
  attempts = 1,
  maxAttempts = 3,
): ClaimedOutboundMessageDelivery {
  const now = new Date('2026-08-11T12:00:00.000Z');
  const delivery: OutboundMessageDelivery = {
    id: 'delivery-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    channel,
    messageType: 'BUDGET_ALERT',
    status: 'PROCESSING',
    subject: channel === 'EMAIL' ? 'Alerta' : undefined,
    preview: 'Mensaje...',
    metadata,
    createdAt: now,
    updatedAt: now,
  };
  return { delivery, body: 'Mensaje completo', attempts, maxAttempts };
}

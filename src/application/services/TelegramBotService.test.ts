import { describe, expect, it } from 'vitest';
import type { FinOpsAiService } from './FinOpsAiService.js';
import type { ITelegramClient } from './TelegramClient.js';
import { TelegramBotService } from './TelegramBotService.js';
import { TelegramLinkService } from './TelegramLinkService.js';
import { TelegramMessageFormatter } from './TelegramMessageFormatter.js';
import type { SavingsReminderService } from './SavingsReminderService.js';
import type { ICostAnalyticsRepository } from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type {
  CreateOrUpdateTelegramLinkInput,
  CreateTelegramAuditEventInput,
  CreateTelegramInteractionLogInput,
  CreateTelegramSelfLinkCodeInput,
  ConsumeTelegramSelfLinkCodeInput,
  ITelegramRepository,
} from '../../domain/interfaces/ITelegramRepository.js';
import type { TelegramChatLink, TelegramInteractionLog, TelegramLinkedUser } from '../../domain/models/Telegram.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';

describe('TelegramBotService', () => {
  it('responds to /start in an unlinked chat without exposing FinOps data', async () => {
    const fixture = createFixture();

    await fixture.service.handleUpdate({
      update_id: 1,
      message: {
        chat: { id: 12345 },
        from: { id: 77, username: 'david' },
        text: '/start',
      },
    });

    expect(fixture.client.messages).toHaveLength(1);
    expect(fixture.client.messages[0]?.text).toContain('Chat ID: 12345');
    expect(fixture.client.messages[0]?.text).not.toContain('Costo total');
    expect(fixture.repository.logs[0]?.status).toBe('IGNORED');
  });

  it('consumes a self-link code before exposing the linked bot commands', async () => {
    const fixture = createFixture();
    fixture.repository.selfLink = buildLink({ chatId: '12345' });

    await fixture.service.handleUpdate({
      message: {
        chat: { id: 12345 },
        from: { id: 77, username: 'david' },
        text: '/start one-time-code',
      },
    });

    expect(fixture.client.messages[0]?.text).toContain('quedó vinculada correctamente');
    expect(fixture.repository.logs[0]?.status).toBe('PROCESSED');
    expect(fixture.repository.logs[0]?.metadata).toEqual({ reason: 'self_link_consumed' });
  });

  it('routes linked free text to the FinOps AI service with the linked tenant and user', async () => {
    const fixture = createFixture();
    fixture.repository.activeLink = buildLink();

    await fixture.service.handleUpdate({
      message: {
        chat: { id: 'chat-1' },
        from: { id: 'tg-1', username: 'finops_user' },
        text: 'Que servicio tiene mayor ahorro?',
      },
    });

    expect(fixture.aiCalls).toEqual([{
      tenantId: 'tenant-1',
      userId: 'user-1',
      message: 'Que servicio tiene mayor ahorro?',
    }]);
    expect(fixture.client.messages[0]?.text).toBe('Respuesta IA en espanol');
    expect(fixture.repository.logs[0]?.status).toBe('PROCESSED');
    expect(fixture.repository.logs[0]?.tenantId).toBe('tenant-1');
  });

  it('uses savings reminders for /recordatorios', async () => {
    const fixture = createFixture();
    fixture.repository.activeLink = buildLink();

    await fixture.service.handleUpdate({
      message: {
        chat: { id: 'chat-1' },
        text: '/recordatorios',
      },
    });

    expect(fixture.client.messages[0]?.text).toContain('Recordatorios de ahorro');
    expect(fixture.client.messages[0]?.text).toContain('¿Sabías que podrías haberte ahorrado');
    expect(fixture.reminderCalls).toEqual([{ tenantId: 'tenant-1', userId: 'user-1' }]);
  });

  it('does not allow disabled linked users to access data', async () => {
    const fixture = createFixture();
    fixture.repository.activeLink = buildLink({
      user: {
        id: 'user-1',
        tenantId: 'tenant-1',
        email: 'client@example.com',
        name: 'Client',
        role: 'CLIENT_VIEWER',
        status: 'DISABLED',
      },
    });

    await fixture.service.handleUpdate({
      message: {
        chat: { id: 'chat-1' },
        text: '/costos',
      },
    });

    expect(fixture.client.messages[0]?.text).toContain('no esta vinculado');
    expect(fixture.repository.logs[0]?.status).toBe('IGNORED');
  });

  it('processes a persisted private update and completes its lease', async () => {
    const fixture = createFixture();
    fixture.repository.activeLink = buildLink();
    fixture.repository.queuedUpdate = {
      id: 'inbound-1',
      updateId: '10',
      payload: { message: { chat: { id: 'chat-1', type: 'private' }, text: '/costos' } },
      status: 'PROCESSING',
      attemptCount: 1,
      maxAttempts: 3,
      nextAttemptAt: new Date('2026-08-31T00:00:00.000Z'),
    };

    const result = await fixture.service.processNextQueuedUpdate({ workerId: 'telegram-inbound-1', leaseMs: 30_000, retryBackoffMs: 1_000 });

    expect(result).toEqual({ processed: true, status: 'PROCESSED' });
    expect(fixture.repository.completedUpdate).toMatchObject({ id: 'inbound-1', workerId: 'telegram-inbound-1', status: 'PROCESSED' });
  });

  it('requeues provider failures without sending a duplicate fallback reply', async () => {
    const fixture = createFixture();
    fixture.aiFailure.value = new Error('provider unavailable');
    fixture.repository.activeLink = buildLink();
    fixture.repository.queuedUpdate = {
      id: 'inbound-2',
      updateId: '11',
      payload: { message: { chat: { id: 'chat-1', type: 'private' }, text: 'Consulta el costo' } },
      status: 'PROCESSING',
      attemptCount: 1,
      maxAttempts: 3,
      nextAttemptAt: new Date('2026-08-31T00:00:00.000Z'),
    };

    const result = await fixture.service.processNextQueuedUpdate({ workerId: 'telegram-inbound-1', leaseMs: 30_000, retryBackoffMs: 1_000 });

    expect(result).toEqual({ processed: true, status: 'PENDING' });
    expect(fixture.repository.completedUpdate).toMatchObject({ id: 'inbound-2', workerId: 'telegram-inbound-1', status: 'PENDING' });
    expect(fixture.client.messages).toHaveLength(0);
    expect(fixture.repository.logs[0]?.status).toBe('ERROR');
  });
});

class FakeTelegramRepository implements ITelegramRepository {
  public activeLink: TelegramChatLink | null = null;
  public selfLink: TelegramChatLink | null = null;
  public logs: TelegramInteractionLog[] = [];
  public queuedUpdate: {
    readonly id: string;
    readonly updateId: string;
    readonly payload: unknown;
    readonly status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED';
    readonly attemptCount: number;
    readonly maxAttempts: number;
    readonly nextAttemptAt: Date;
  } | null = null;
  public completedUpdate: { readonly id: string; readonly workerId: string; readonly status: 'PENDING' | 'PROCESSED' | 'FAILED' } | null = null;

  public async findUserByEmailInTenant(_tenantId: string, _email: string): Promise<TelegramLinkedUser | null> {
    return null;
  }

  public async findLinksByTenant(_tenantId: string): Promise<TelegramChatLink[]> {
    return [];
  }

  public async findLinkById(_tenantId: string, _id: string): Promise<TelegramChatLink | null> {
    return null;
  }

  public async findActiveLinkByChatId(_chatId: string): Promise<TelegramChatLink | null> {
    return this.activeLink;
  }

  public async findAnyLinkByChatId(_chatId: string): Promise<TelegramChatLink | null> {
    return this.activeLink;
  }

  public async findActiveLinkByUserId(_userId: string): Promise<TelegramChatLink | null> {
    return this.activeLink;
  }

  public async createOrUpdateLink(_input: CreateOrUpdateTelegramLinkInput): Promise<TelegramChatLink> {
    throw new Error('Not used');
  }

  public async createSelfLinkCode(_input: CreateTelegramSelfLinkCodeInput): Promise<void> {
    return undefined;
  }

  public async consumeSelfLinkCode(_input: ConsumeTelegramSelfLinkCodeInput): Promise<TelegramChatLink | null> {
    return this.selfLink;
  }

  public async disableLink(_tenantId: string, _id: string): Promise<TelegramChatLink | null> {
    return null;
  }

  public async createInteractionLog(input: CreateTelegramInteractionLogInput): Promise<TelegramInteractionLog> {
    const log: TelegramInteractionLog = {
      id: `log-${this.logs.length + 1}`,
      chatId: input.chatId,
      status: input.status,
      createdAt: new Date('2026-05-11T00:00:00.000Z'),
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.telegramUserId !== undefined ? { telegramUserId: input.telegramUserId } : {}),
      ...(input.telegramUsername !== undefined ? { telegramUsername: input.telegramUsername } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.textPreview !== undefined ? { textPreview: input.textPreview } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    this.logs.push(log);
    return log;
  }

  public async createAuditEvent(_input: CreateTelegramAuditEventInput): Promise<void> {
    return undefined;
  }

  public async findTenantOptionsForUser(_userId: string, activeTenantId: string) {
    return [{ id: activeTenantId, name: 'Tenant de prueba', slug: 'tenant-prueba', isActive: true }];
  }

  public async setActiveTenantForChat(_input: { readonly chatId: string; readonly userId: string; readonly tenantId: string }): Promise<TelegramChatLink | null> {
    return this.activeLink;
  }

  public async enqueueInboundUpdate(_input: { readonly updateId: string; readonly payload: unknown }): Promise<'ENQUEUED' | 'DUPLICATE'> {
    return 'ENQUEUED';
  }

  public async claimNextInboundUpdate(_input: { readonly workerId: string; readonly leaseExpiredBefore: Date }) {
    return this.queuedUpdate;
  }

  public async completeInboundUpdate(input: { readonly id: string; readonly workerId: string; readonly status: 'PENDING' | 'PROCESSED' | 'FAILED'; readonly errorMessage?: string; readonly nextAttemptAt?: Date }) {
    this.completedUpdate = { id: input.id, workerId: input.workerId, status: input.status };
    return null;
  }
}

class FakeTelegramClient implements ITelegramClient {
  public messages: { readonly chatId: string; readonly text: string }[] = [];

  public async sendMessage(input: { readonly chatId: string; readonly text: string }): Promise<void> {
    this.messages.push(input);
  }
}

function createFixture(): {
  readonly repository: FakeTelegramRepository;
  readonly client: FakeTelegramClient;
  readonly service: TelegramBotService;
  readonly aiFailure: { value: Error | undefined };
  readonly aiCalls: { readonly tenantId: string; readonly userId?: string; readonly message: string }[];
  readonly reminderCalls: { readonly tenantId: string; readonly userId: string }[];
} {
  const repository = new FakeTelegramRepository();
  const client = new FakeTelegramClient();
  const aiCalls: { readonly tenantId: string; readonly userId?: string; readonly message: string }[] = [];
  const reminderCalls: { readonly tenantId: string; readonly userId: string }[] = [];
  const aiFailure: { value: Error | undefined } = { value: undefined };

  const aiService = {
    answerChat: async (input: { readonly tenantId: string; readonly userId?: string; readonly message: string }) => {
      if (aiFailure.value !== undefined) throw aiFailure.value;
      aiCalls.push(input);
      return {
        answer: 'Respuesta IA en espanol',
        snapshot: emptySnapshot(input.tenantId),
      };
    },
  } as unknown as FinOpsAiService;

  const savingsReminderService = {
    getNotificationsForUser: async (query: { readonly tenantId: string; readonly userId: string }) => {
      reminderCalls.push(query);
      return {
        unreadCount: 1,
        previewCount: 1,
        notifications: [{
          id: 'preview-rec-1',
          tenantId: query.tenantId,
          userId: query.userId,
          recommendationId: 'rec-1',
          type: 'SAVINGS_REMINDER',
          status: 'UNREAD',
          title: 'Ahorro no capturado',
          message: '¿Sabías que podrías haberte ahorrado USD 10.00 desde que se generó esta oportunidad?',
          missedSavingsAmount: 10,
          estimatedMonthlySavings: 30,
          currency: 'USD',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-05-11T00:00:00.000Z'),
          generatedForDate: new Date('2026-05-11T00:00:00.000Z'),
          metadata: { source: 'test' },
          persisted: false,
          createdAt: new Date('2026-05-11T00:00:00.000Z'),
          updatedAt: new Date('2026-05-11T00:00:00.000Z'),
        }],
      };
    },
  } as unknown as SavingsReminderService;

  const recommendationRepository = {
    findByTenant: async (): Promise<FinOpsRecommendation[]> => [buildRecommendation()],
  } as unknown as IRecommendationRepository;

  const analyticsRepository = {
    getLatestTenantSnapshot: async (tenantId: string) => emptySnapshot(tenantId),
  } as unknown as ICostAnalyticsRepository;

  return {
    repository,
    client,
    aiCalls,
    reminderCalls,
    aiFailure,
    service: new TelegramBotService(
      repository,
      client,
      new TelegramMessageFormatter(),
      aiService,
      savingsReminderService,
      recommendationRepository,
      analyticsRepository,
      'finops_bot',
      new TelegramLinkService(repository, client),
    ),
  };
}

function buildLink(overrides: Partial<TelegramChatLink> = {}): TelegramChatLink {
  return {
    id: 'link-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    chatId: 'chat-1',
    telegramUserId: 'tg-1',
    telegramUsername: 'finops_user',
    status: 'ACTIVE',
    linkedByUserId: 'admin-1',
    createdAt: new Date('2026-05-11T00:00:00.000Z'),
    updatedAt: new Date('2026-05-11T00:00:00.000Z'),
    user: {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'client@example.com',
      name: 'Client',
      role: 'CLIENT_VIEWER',
      status: 'ACTIVE',
    },
    ...overrides,
  };
}

function buildRecommendation(): FinOpsRecommendation {
  return {
    id: 'rec-1',
    cloudAccountId: 'account-1',
    type: 'RIGHTSIZING',
    status: 'PENDING',
    severity: 'MEDIUM',
    title: 'Reducir instancia sobredimensionada',
    description: 'Reducir tamano de instancia',
    evidence: {},
    estimatedMonthlySavings: 120,
    currency: 'USD',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  };
}

function emptySnapshot(tenantId: string) {
  return {
    tenantId,
    periodStart: '2026-05-01T00:00:00.000Z',
    periodEnd: '2026-05-11T00:00:00.000Z',
    totalCost: 100,
    currency: 'USD',
    metricCount: 10,
    providers: [{ provider: 'oci', totalCost: 100, metricCount: 10 }],
    accounts: [],
    services: [{ serviceName: 'Compute', provider: 'oci', totalCost: 80, metricCount: 8 }],
    environments: [],
    topResources: [],
    topUsage: [],
    usageInsights: [],
    anomalies: [],
    forecasts: [],
  };
}

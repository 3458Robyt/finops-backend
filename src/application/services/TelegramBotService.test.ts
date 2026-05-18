import { describe, expect, it } from 'vitest';
import type { FinOpsAiService } from './FinOpsAiService.js';
import type { ITelegramClient } from './TelegramClient.js';
import { TelegramBotService } from './TelegramBotService.js';
import { TelegramMessageFormatter } from './TelegramMessageFormatter.js';
import type { SavingsReminderService } from './SavingsReminderService.js';
import type { ICostAnalyticsRepository } from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type {
  CreateOrUpdateTelegramLinkInput,
  CreateTelegramAuditEventInput,
  CreateTelegramInteractionLogInput,
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
    expect(fixture.client.messages[0]?.text).toContain('Sabias que te podrias haber ahorrado');
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
});

class FakeTelegramRepository implements ITelegramRepository {
  public activeLink: TelegramChatLink | null = null;
  public logs: TelegramInteractionLog[] = [];

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

  public async createOrUpdateLink(_input: CreateOrUpdateTelegramLinkInput): Promise<TelegramChatLink> {
    throw new Error('Not used');
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
  readonly aiCalls: { readonly tenantId: string; readonly userId?: string; readonly message: string }[];
  readonly reminderCalls: { readonly tenantId: string; readonly userId: string }[];
} {
  const repository = new FakeTelegramRepository();
  const client = new FakeTelegramClient();
  const aiCalls: { readonly tenantId: string; readonly userId?: string; readonly message: string }[] = [];
  const reminderCalls: { readonly tenantId: string; readonly userId: string }[] = [];

  const aiService = {
    answerChat: async (input: { readonly tenantId: string; readonly userId?: string; readonly message: string }) => {
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
          message: 'Sabias que te podrias haber ahorrado USD 10.00 desde que se genero esta recomendacion.',
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
    service: new TelegramBotService(
      repository,
      client,
      new TelegramMessageFormatter(),
      aiService,
      savingsReminderService,
      recommendationRepository,
      analyticsRepository,
      'finops_bot',
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

import { describe, expect, it } from 'vitest';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { InAppNotification } from '../../domain/models/InAppNotification.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import { SavingsReminderService } from './SavingsReminderService.js';

describe('SavingsReminderService', () => {
  it('builds preview reminders with missed savings without persisting automatic notifications', async () => {
    const recommendation = buildRecommendation({
      id: 'rec-1',
      title: 'Apagar recursos fuera de horario',
      estimatedMonthlySavings: 300,
      createdAt: new Date('2026-04-07T00:00:00.000Z'),
    });
    const recommendationRepository = new FakeRecommendationRepository([recommendation]);
    const notificationRepository = new FakeNotificationRepository();
    const service = new SavingsReminderService(
      recommendationRepository as unknown as IRecommendationRepository,
      notificationRepository,
    );

    const result = await service.getNotificationsForUser({
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-05-07T00:00:00.000Z'),
    });

    expect(result.previewCount).toBe(1);
    expect(result.unreadCount).toBe(1);
    expect(result.notifications[0]).toMatchObject({
      id: 'preview-rec-1',
      persisted: false,
      missedSavingsAmount: 300,
      title: 'Ahorro no capturado',
    });
    expect(result.notifications[0]?.message).toContain('¿Sabías que podrías haberte ahorrado USD 300.00');
    expect(notificationRepository.created).toHaveLength(0);
  });

  it('does not generate savings reminders for completed recommendations', async () => {
    const recommendationRepository = new FakeRecommendationRepository([
      buildRecommendation({
        id: 'rec-1',
        status: 'MANUAL_COMPLETED',
        estimatedMonthlySavings: 300,
        createdAt: new Date('2026-04-07T00:00:00.000Z'),
      }),
    ]);
    const service = new SavingsReminderService(
      recommendationRepository as unknown as IRecommendationRepository,
      new FakeNotificationRepository(),
    );

    const result = await service.getNotificationsForUser({
      tenantId: 'tenant-1',
      userId: 'user-1',
      now: new Date('2026-05-07T00:00:00.000Z'),
    });

    expect(result.previewCount).toBe(0);
    expect(result.notifications).toHaveLength(0);
  });
});

class FakeRecommendationRepository {
  constructor(private readonly recommendations: readonly FinOpsRecommendation[]) {}

  public async findByTenant(): Promise<FinOpsRecommendation[]> {
    return [...this.recommendations];
  }
}

class FakeNotificationRepository implements Pick<INotificationRepository, 'findByUser' | 'countUnread' | 'create' | 'updateStatus'> {
  public readonly created: InAppNotification[] = [];

  public async findByUser(): Promise<InAppNotification[]> {
    return [];
  }

  public async countUnread(): Promise<number> {
    return 0;
  }

  public async create(): Promise<InAppNotification> {
    throw new Error('create should not be called for previews');
  }

  public async updateStatus(): Promise<InAppNotification | null> {
    return null;
  }
}

function buildRecommendation(input: {
  readonly id: string;
  readonly title?: string;
  readonly status?: FinOpsRecommendation['status'];
  readonly estimatedMonthlySavings?: number;
  readonly createdAt: Date;
}): FinOpsRecommendation {
  return {
    id: input.id,
    cloudAccountId: 'cloud-1',
    type: 'COMPUTE_RIGHTSIZING',
    status: input.status ?? 'PENDING',
    severity: 'HIGH',
    title: input.title ?? 'Optimizar recurso',
    description: 'Reducir gasto sin afectar operacion.',
    evidence: {},
    ...(input.estimatedMonthlySavings !== undefined
      ? { estimatedMonthlySavings: input.estimatedMonthlySavings }
      : {}),
    currency: 'USD',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

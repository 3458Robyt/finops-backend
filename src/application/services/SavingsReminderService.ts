import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { InAppNotification } from '../../domain/models/InAppNotification.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';

export interface SavingsReminderQuery {
  readonly tenantId: string;
  readonly userId: string;
  readonly now?: Date;
}

export interface SavingsReminderResult {
  readonly notifications: readonly InAppNotification[];
  readonly unreadCount: number;
  readonly previewCount: number;
}

const millisecondsPerDay = 24 * 60 * 60 * 1000;

export class SavingsReminderService {
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly notificationRepository: INotificationRepository,
  ) {}

  public async getNotificationsForUser(query: SavingsReminderQuery): Promise<SavingsReminderResult> {
    const now = query.now ?? new Date();
    const [persistedNotifications, unreadCount, recommendations] = await Promise.all([
      this.notificationRepository.findByUser({
        tenantId: query.tenantId,
        userId: query.userId,
        limit: 20,
      }),
      this.notificationRepository.countUnread(query.tenantId, query.userId),
      this.recommendationRepository.findByTenant({ tenantId: query.tenantId }),
    ]);

    const previews = this.buildSavingsReminderPreviews(query.tenantId, query.userId, recommendations, now);

    return {
      notifications: [...previews, ...persistedNotifications].slice(0, 20),
      unreadCount: unreadCount + previews.length,
      previewCount: previews.length,
    };
  }

  public async markRead(
    tenantId: string,
    userId: string,
    notificationId: string,
  ): Promise<InAppNotification | null> {
    return this.notificationRepository.updateStatus(tenantId, userId, notificationId, 'READ');
  }

  public async dismiss(
    tenantId: string,
    userId: string,
    notificationId: string,
  ): Promise<InAppNotification | null> {
    return this.notificationRepository.updateStatus(tenantId, userId, notificationId, 'DISMISSED');
  }

  private buildSavingsReminderPreviews(
    tenantId: string,
    userId: string,
    recommendations: readonly FinOpsRecommendation[],
    now: Date,
  ): InAppNotification[] {
    return recommendations
      .filter((recommendation) => recommendation.status === 'PENDING' || recommendation.status === 'APPROVED')
      .map((recommendation) => this.toSavingsReminderPreview(tenantId, userId, recommendation, now))
      .filter((notification): notification is InAppNotification => notification !== null)
      .sort((left, right) => (right.missedSavingsAmount ?? 0) - (left.missedSavingsAmount ?? 0))
      .slice(0, 3);
  }

  private toSavingsReminderPreview(
    tenantId: string,
    userId: string,
    recommendation: FinOpsRecommendation,
    now: Date,
  ): InAppNotification | null {
    const estimatedMonthlySavings = recommendation.estimatedMonthlySavings ?? 0;
    const elapsedDays = Math.max(0, Math.floor((now.getTime() - recommendation.createdAt.getTime()) / millisecondsPerDay));
    const missedSavingsAmount = roundCurrency((estimatedMonthlySavings / 30) * elapsedDays);

    if (missedSavingsAmount <= 0.01) {
      return null;
    }

    return {
      id: `preview-${recommendation.id}`,
      tenantId,
      userId,
      recommendationId: recommendation.id,
      type: 'SAVINGS_REMINDER',
      status: 'UNREAD',
      title: 'Ahorro no capturado',
      message: `Sabias que te podrias haber ahorrado ${recommendation.currency} ${missedSavingsAmount.toFixed(2)} desde que se genero esta recomendacion: "${recommendation.title}".`,
      missedSavingsAmount,
      estimatedMonthlySavings,
      currency: recommendation.currency,
      periodStart: recommendation.createdAt,
      periodEnd: now,
      generatedForDate: startOfUtcDay(now),
      metadata: {
        recommendationStatus: recommendation.status,
        source: 'calculated_preview',
      },
      persisted: false,
      createdAt: now,
      updatedAt: now,
    };
  }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

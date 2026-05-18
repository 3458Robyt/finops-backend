export type InAppNotificationType = 'SAVINGS_REMINDER';

export type InAppNotificationStatus = 'UNREAD' | 'READ' | 'DISMISSED';

export interface InAppNotification {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly recommendationId?: string;
  readonly type: InAppNotificationType;
  readonly status: InAppNotificationStatus;
  readonly title: string;
  readonly message: string;
  readonly missedSavingsAmount?: number;
  readonly estimatedMonthlySavings?: number;
  readonly currency: string;
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly generatedForDate?: Date;
  readonly metadata?: unknown;
  readonly persisted: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

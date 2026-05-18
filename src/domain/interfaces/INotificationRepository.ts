import type {
  InAppNotification,
  InAppNotificationStatus,
  InAppNotificationType,
} from '../models/InAppNotification.js';

export interface ListNotificationsQuery {
  readonly tenantId: string;
  readonly userId: string;
  readonly includeDismissed?: boolean;
  readonly limit?: number;
}

export interface CreateInAppNotificationInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly recommendationId?: string;
  readonly type: InAppNotificationType;
  readonly title: string;
  readonly message: string;
  readonly missedSavingsAmount?: number;
  readonly estimatedMonthlySavings?: number;
  readonly currency: string;
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly generatedForDate?: Date;
  readonly metadata?: unknown;
}

export interface INotificationRepository {
  findByUser(query: ListNotificationsQuery): Promise<InAppNotification[]>;
  create(input: CreateInAppNotificationInput): Promise<InAppNotification>;
  updateStatus(
    tenantId: string,
    userId: string,
    notificationId: string,
    status: InAppNotificationStatus,
  ): Promise<InAppNotification | null>;
  countUnread(tenantId: string, userId: string): Promise<number>;
}

import type {
  CreateInAppNotificationInput,
  INotificationRepository,
  ListNotificationsQuery,
} from '../../domain/interfaces/INotificationRepository.js';
import type {
  InAppNotification,
  InAppNotificationStatus,
} from '../../domain/models/InAppNotification.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

export class PrismaNotificationRepository implements INotificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findByUser(query: ListNotificationsQuery): Promise<InAppNotification[]> {
    const rows = await this.prisma.inAppNotification.findMany({
      where: {
        tenantId: query.tenantId,
        userId: query.userId,
        ...(query.includeDismissed === true ? {} : { status: { not: 'DISMISSED' } }),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 20,
    });

    return rows.map((row) => this.toDomain(row));
  }

  public async create(input: CreateInAppNotificationInput): Promise<InAppNotification> {
    const row = await this.prisma.inAppNotification.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        ...(input.recommendationId !== undefined ? { recommendationId: input.recommendationId } : {}),
        type: input.type,
        title: input.title,
        message: input.message,
        ...(input.missedSavingsAmount !== undefined ? { missedSavingsAmount: input.missedSavingsAmount } : {}),
        ...(input.estimatedMonthlySavings !== undefined ? { estimatedMonthlySavings: input.estimatedMonthlySavings } : {}),
        currency: input.currency,
        ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
        ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
        ...(input.generatedForDate !== undefined ? { generatedForDate: input.generatedForDate } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    return this.toDomain(row);
  }

  public async updateStatus(
    tenantId: string,
    userId: string,
    notificationId: string,
    status: InAppNotificationStatus,
  ): Promise<InAppNotification | null> {
    await this.prisma.inAppNotification.updateMany({
      where: {
        id: notificationId,
        tenantId,
        userId,
      },
      data: { status },
    });

    const row = await this.prisma.inAppNotification.findFirst({
      where: {
        id: notificationId,
        tenantId,
        userId,
      },
    });

    return row === null ? null : this.toDomain(row);
  }

  public async countUnread(tenantId: string, userId: string): Promise<number> {
    return this.prisma.inAppNotification.count({
      where: {
        tenantId,
        userId,
        status: 'UNREAD',
      },
    });
  }

  private toDomain(row: Awaited<ReturnType<PrismaClient['inAppNotification']['findFirst']>> & {}): InAppNotification {
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      ...(row.recommendationId !== null ? { recommendationId: row.recommendationId } : {}),
      type: row.type,
      status: row.status,
      title: row.title,
      message: row.message,
      ...(row.missedSavingsAmount !== null ? { missedSavingsAmount: Number(row.missedSavingsAmount) } : {}),
      ...(row.estimatedMonthlySavings !== null ? { estimatedMonthlySavings: Number(row.estimatedMonthlySavings) } : {}),
      currency: row.currency,
      ...(row.periodStart !== null ? { periodStart: row.periodStart } : {}),
      ...(row.periodEnd !== null ? { periodEnd: row.periodEnd } : {}),
      ...(row.generatedForDate !== null ? { generatedForDate: row.generatedForDate } : {}),
      ...(row.metadata !== null ? { metadata: row.metadata } : {}),
      persisted: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

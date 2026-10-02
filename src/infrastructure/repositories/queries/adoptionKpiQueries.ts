import type {
  AdoptionEngagement,
  AdoptionEngagementPeriod,
  AdoptionKpiQuery,
} from '../../../domain/interfaces/IRecommendationRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

type ActivityKind = 'chat' | 'telegram' | 'decision' | 'execution';

interface Activity {
  readonly userId: string;
  readonly at: Date;
  readonly kind: ActivityKind;
}

/** Construye indicadores de interacción del tenant usando los registros FinOps existentes. */
export async function computeAdoptionEngagement(
  prisma: PrismaClient,
  tenantId: string,
  query: AdoptionKpiQuery = {},
): Promise<AdoptionEngagement> {
  const range = dateRange(query);
  const [chatTraces, telegramInteractions, notifications, decisions, executions, outboundSent] = await Promise.all([
    prisma.aiContextTrace.findMany({
      where: { tenantId, operation: 'CHAT', source: 'WEB', userId: { not: null }, ...range },
      select: { userId: true, createdAt: true },
    }).then((rows) => rows.filter((row) => row.userId !== null)),
    prisma.telegramInteractionLog.findMany({
      where: { tenantId, ...range },
      select: { userId: true, createdAt: true },
    }),
    prisma.inAppNotification.findMany({
      where: { tenantId, ...range },
      select: { userId: true, recommendationId: true, status: true, createdAt: true, readAt: true },
    }),
    prisma.recommendationDecision.findMany({
      where: { recommendation: { tenantId }, ...range },
      select: { userId: true, actorRole: true, decision: true, recommendationId: true, createdAt: true },
    }),
    prisma.recommendationManualExecution.findMany({
      where: { tenantId, ...range },
      select: { userId: true, createdAt: true },
    }),
    prisma.outboundMessageDelivery.count({
      where: { tenantId, status: 'SENT', ...range },
    }),
  ]);

  const activities: Activity[] = [
    ...chatTraces.map((row) => ({ userId: row.userId!, at: row.createdAt, kind: 'chat' as const })),
    ...telegramInteractions.flatMap((row) => row.userId === null ? [] : [{ userId: row.userId, at: row.createdAt, kind: 'telegram' as const }]),
    ...notifications.flatMap((row) => (
      row.userId !== null && (row.status === 'READ' || row.status === 'DISMISSED')
        ? [{ userId: row.userId, at: row.readAt ?? row.createdAt, kind: 'decision' as const }]
        : []
    )),
    ...decisions.map((row) => ({ userId: row.userId, at: row.createdAt, kind: 'decision' as const })),
    ...executions.map((row) => ({ userId: row.userId, at: row.createdAt, kind: 'execution' as const })),
  ];

  const activeUserIds = new Set(activities.map((activity) => activity.userId));
  const recurringPeriods = new Map<string, Set<string>>();
  for (const activity of activities) {
    const periods = recurringPeriods.get(activity.userId) ?? new Set<string>();
    periods.add(periodStart(activity.at, query.granularity ?? 'month'));
    recurringPeriods.set(activity.userId, periods);
  }

  const decisionsByRole: Record<string, number> = {};
  for (const decision of decisions) {
    const role = decision.actorRole ?? 'UNKNOWN';
    decisionsByRole[role] = (decisionsByRole[role] ?? 0) + 1;
  }

  const notificationReadCount = notifications.filter((row) => row.status === 'READ' || row.readAt !== null).length;
  const readDurations = notifications
    .filter((row) => row.readAt !== null)
    .map((row) => minutesBetween(row.createdAt, row.readAt!));
  const alertTimes = new Map<string, Date>();
  for (const notification of notifications) {
    if (notification.recommendationId === null) continue;
    const current = alertTimes.get(notification.recommendationId);
    if (current === undefined || notification.createdAt < current) alertTimes.set(notification.recommendationId, notification.createdAt);
  }
  const decisionDurations = decisions.flatMap((decision) => {
    const alertAt = alertTimes.get(decision.recommendationId);
    return alertAt === undefined ? [] : [minutesBetween(alertAt, decision.createdAt)];
  });

  return {
    activeUsers: activeUserIds.size,
    recurringUsers: [...recurringPeriods.values()].filter((periods) => periods.size >= 2).length,
    chatInteractions: chatTraces.length,
    chatUsers: new Set(chatTraces.map((row) => row.userId!)).size,
    telegramInteractions: telegramInteractions.length,
    notificationCount: notifications.length,
    notificationsRead: notificationReadCount,
    notificationsDismissed: notifications.filter((row) => row.status === 'DISMISSED').length,
    notificationReadRate: notifications.length === 0 ? 0 : notificationReadCount / notifications.length,
    outboundSent,
    ...(readDurations.length > 0 ? { medianAlertToReadMinutes: median(readDurations) } : {}),
    ...(decisionDurations.length > 0 ? { medianAlertToDecisionMinutes: median(decisionDurations) } : {}),
    decisionsByRole,
    series: buildSeries(activities, decisions, executions, query.granularity ?? 'month'),
  };
}

function buildSeries(
  activities: readonly Activity[],
  decisions: readonly { readonly createdAt: Date }[],
  executions: readonly { readonly createdAt: Date }[],
  granularity: NonNullable<AdoptionKpiQuery['granularity']>,
): AdoptionEngagementPeriod[] {
  const periods = new Map<string, { users: Set<string>; chat: number; telegram: number; decisions: number; executions: number }>();
  const get = (at: Date) => {
    const key = periodStart(at, granularity);
    const existing = periods.get(key) ?? { users: new Set<string>(), chat: 0, telegram: 0, decisions: 0, executions: 0 };
    periods.set(key, existing);
    return existing;
  };
  for (const activity of activities) {
    const target = get(activity.at);
    target.users.add(activity.userId);
    if (activity.kind === 'chat') target.chat += 1;
    if (activity.kind === 'telegram') target.telegram += 1;
  }
  for (const decision of decisions) get(decision.createdAt).decisions += 1;
  for (const execution of executions) get(execution.createdAt).executions += 1;
  return [...periods.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([periodStartValue, value]) => ({
    periodStart: periodStartValue,
    activeUsers: value.users.size,
    chatInteractions: value.chat,
    telegramInteractions: value.telegram,
    decisions: value.decisions,
    executions: value.executions,
  }));
}

function dateRange(query: AdoptionKpiQuery): { readonly createdAt?: { readonly gte?: Date; readonly lt?: Date } } {
  if (query.from === undefined && query.to === undefined) return {};
  return {
    createdAt: {
      ...(query.from !== undefined ? { gte: query.from } : {}),
      ...(query.to !== undefined ? { lt: query.to } : {}),
    },
  };
}

function periodStart(value: Date, granularity: NonNullable<AdoptionKpiQuery['granularity']>): string {
  const date = new Date(value);
  if (granularity === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
  if (granularity === 'day') return date.toISOString().slice(0, 10);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 60_000);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return Number((sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!).toFixed(2));
}

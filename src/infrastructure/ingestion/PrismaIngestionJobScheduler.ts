import type { PrismaClient } from '../../generated/prisma/client.js';
import {
  buildIngestionSchedulePlan,
  type IngestionScheduleOptions,
} from './ingestionJobScheduler.js';

export interface PrismaIngestionJobSchedulerRunOptions {
  readonly apply: boolean;
  readonly schedule: IngestionScheduleOptions;
  readonly providerCode?: string;
  readonly connectionId?: string;
}

export interface PrismaIngestionJobSchedulerRunResult {
  readonly mode: 'apply' | 'dry-run';
  readonly generatedAt: Date;
  readonly connectionsEvaluated: number;
  readonly plannedJobs: readonly {
    readonly cloudConnectionId: string;
    readonly providerCode: string;
    readonly sourceType: string;
    readonly targetStart: Date;
    readonly targetEnd: Date;
    readonly reason: string;
  }[];
  readonly createdJobs: readonly {
    readonly id: string;
    readonly cloudConnectionId: string;
    readonly sourceType: string;
    readonly status: string;
    readonly targetStart: Date;
    readonly targetEnd: Date;
  }[];
  readonly skipped: readonly {
    readonly cloudConnectionId: string;
    readonly providerCode: string;
    readonly sourceType: string;
    readonly reason: string;
  }[];
}

export async function runPrismaIngestionJobScheduler(
  prisma: PrismaClient,
  options: PrismaIngestionJobSchedulerRunOptions,
): Promise<PrismaIngestionJobSchedulerRunResult> {
  const connections = await prisma.cloudConnection.findMany({
    where: {
      providerCode: options.providerCode === undefined ? { in: ['aws', 'oci'] } : options.providerCode,
      status: 'ACTIVE',
      ...(options.connectionId !== undefined ? { id: options.connectionId } : {}),
    },
    orderBy: [{ providerCode: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      tenantId: true,
      providerCode: true,
      metadata: true,
      credentials: {
        select: {
          purpose: true,
          status: true,
        },
      },
      ingestionJobs: {
        where: {
          sourceType: { in: ['TECHNICAL_METRIC', 'BILLING_EXPORT'] },
          status: { in: ['PENDING', 'RUNNING', 'SUCCESS'] },
        },
        orderBy: { targetEnd: 'desc' },
        take: 20,
        select: {
          sourceType: true,
          status: true,
          targetEnd: true,
        },
      },
    },
  });

  const plan = buildIngestionSchedulePlan(connections, options.schedule);
  const createdJobs = options.apply
    ? await Promise.all(plan.jobs.map((job) => prisma.ingestionJob.create({
        data: {
          tenantId: job.tenantId,
          cloudConnectionId: job.cloudConnectionId,
          sourceType: job.sourceType,
          targetStart: job.targetStart,
          targetEnd: job.targetEnd,
          maxAttempts: job.maxAttempts,
        },
        select: {
          id: true,
          cloudConnectionId: true,
          sourceType: true,
          status: true,
          targetStart: true,
          targetEnd: true,
        },
      })))
    : [];

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    generatedAt: options.schedule.now,
    connectionsEvaluated: connections.length,
    plannedJobs: plan.jobs.map((job) => ({
      cloudConnectionId: job.cloudConnectionId,
      providerCode: job.providerCode,
      sourceType: job.sourceType,
      targetStart: job.targetStart,
      targetEnd: job.targetEnd,
      reason: job.reason,
    })),
    createdJobs,
    skipped: plan.skipped,
  };
}

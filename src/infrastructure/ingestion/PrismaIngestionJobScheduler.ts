import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
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
  return prisma.$transaction(async (tx) => {
    const lockRows = await tx.$queryRaw<readonly { readonly locked: boolean }[]>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(hashtext('finops:ingestion:scheduler')) AS locked
    `);
    if (lockRows[0]?.locked !== true) {
      return {
        mode: options.apply ? 'apply' : 'dry-run',
        generatedAt: options.schedule.now,
        connectionsEvaluated: 0,
        plannedJobs: [],
        createdJobs: [],
        skipped: [],
      } satisfies PrismaIngestionJobSchedulerRunResult;
    }

    const connections = await tx.cloudConnection.findMany({
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
      lastValidatedAt: true,
      metadata: true,
      credentials: {
        select: {
          purpose: true,
          status: true,
        },
      },
      ingestionJobs: {
        where: {
          sourceType: { in: ['INVENTORY', 'TECHNICAL_METRIC', 'BILLING_EXPORT'] },
          status: { in: ['PENDING', 'RUNNING', 'SUCCESS'] },
        },
        orderBy: { targetEnd: 'desc' },
        take: 20,
        select: {
          sourceType: true,
          status: true,
          targetEnd: true,
          configurationHash: true,
        },
      },
      metricDefinitions: {
        where: { enabled: true },
        select: { enabled: true },
      },
      ingestionCoverageSegments: {
        where: {
          sourceType: { in: ['INVENTORY', 'TECHNICAL_METRIC', 'BILLING_EXPORT'] },
          status: { in: ['COVERED', 'PARTIAL'] },
        },
        orderBy: { targetEnd: 'desc' },
        take: 200,
        select: {
          sourceType: true,
          status: true,
          targetStart: true,
          targetEnd: true,
          configurationHash: true,
        },
      },
    },
    });

  const plan = buildIngestionSchedulePlan(connections, options.schedule);
  const createdJobs = options.apply
    ? await Promise.all(plan.jobs.map((job) => tx.ingestionJob.create({
        data: {
          tenantId: job.tenantId,
          cloudConnectionId: job.cloudConnectionId,
          sourceType: job.sourceType,
          targetStart: job.targetStart,
          targetEnd: job.targetEnd,
          maxAttempts: job.maxAttempts,
          ...(job.configurationHash !== undefined ? { configurationHash: job.configurationHash } : {}),
          ...(job.requestContext !== undefined ? { requestContext: job.requestContext as Prisma.InputJsonValue } : {}),
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
  }, {
    maxWait: 10_000,
    timeout: 60_000,
  });
}

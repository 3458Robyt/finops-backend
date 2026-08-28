import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  buildIngestionSchedulePlan,
  type IngestionScheduleOptions,
} from './ingestionJobScheduler.js';
import { buildIngestionConfigurationHash } from './ingestionConfigurationHash.js';

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
          status: { in: ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED'] },
        },
        orderBy: { targetEnd: 'desc' },
        take: 5000,
        select: {
          sourceType: true,
          status: true,
          dataOutcome: true,
          targetStart: true,
          targetEnd: true,
          configurationHash: true,
          resultSummary: true,
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
        take: 5000,
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

  const metricWindowMinutes = Math.max(30, options.schedule.metricCatchupWindowMinutes ?? 24 * 60);
  const metricWindowSeconds = metricWindowMinutes * 60;
  const metricFloor = new Date(options.schedule.now.getTime() - (options.schedule.metricCatchupDays ?? 90) * 24 * 60 * 60 * 1000);
  const metricFloorDay = new Date(Date.UTC(
    metricFloor.getUTCFullYear(),
    metricFloor.getUTCMonth(),
    metricFloor.getUTCDate(),
  ));
  const metricResolutionSeconds = 30 * 60;
  const metricCoverage: Array<readonly [string, readonly Date[]]> = [];
  for (const connection of connections) {
    const requestContext = { interval: '30m', resolutionSeconds: metricResolutionSeconds };
    const configurationHash = buildIngestionConfigurationHash({
      providerCode: connection.providerCode,
      sourceType: 'TECHNICAL_METRIC',
      metadata: connection.metadata,
      requestContext,
    });
    const coverageCount = await tx.$queryRaw<readonly { readonly total: bigint }[]>`
      SELECT COUNT(*)::bigint AS total
      FROM resource_metric_coverage_windows
      WHERE tenant_id = ${connection.tenantId}
        AND cloud_connection_id = ${connection.id}
    `;
    const hasCoverageRows = Number(coverageCount[0]?.total ?? 0) > 0;
    const rows = hasCoverageRows
      ? await tx.$queryRaw<readonly { readonly window_start: Date }[]>`
          WITH expected AS (
            SELECT COUNT(*)::int AS expected_streams
            FROM cloud_metric_definitions definition
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(definition.statistics) = 'array' THEN definition.statistics
                ELSE '[]'::jsonb
              END
            ) AS statistic(value)
            WHERE definition.tenant_id = ${connection.tenantId}
              AND definition.cloud_connection_id = ${connection.id}
              AND definition.enabled = true
          ), daily AS (
            SELECT
              window_start,
              COUNT(DISTINCT stream_key)::int AS observed_streams,
              COUNT(*)::int AS coverage_rows,
              COUNT(*) FILTER (WHERE status = 'COVERED'::"MetricCoverageStatus")::int AS covered_rows
            FROM resource_metric_coverage_windows
            WHERE tenant_id = ${connection.tenantId}
              AND cloud_connection_id = ${connection.id}
              AND configuration_hash = ${configurationHash}
              AND granularity_seconds = ${metricResolutionSeconds}
              AND window_start >= ${metricFloorDay}
              AND window_start < ${options.schedule.now}
            GROUP BY window_start
          )
          SELECT daily.window_start
          FROM daily
          CROSS JOIN expected
          WHERE daily.coverage_rows > 0
            AND daily.covered_rows = daily.coverage_rows
            AND daily.observed_streams >= GREATEST(expected.expected_streams, 1)
          ORDER BY daily.window_start ASC
        `
      : await tx.$queryRaw<readonly { readonly window_start: Date }[]>`
          SELECT to_timestamp(
            floor(extract(epoch FROM sampled_at) / ${metricWindowSeconds}) * ${metricWindowSeconds}
          ) AS window_start
          FROM resource_metric_samples
          WHERE tenant_id = ${connection.tenantId}
            AND cloud_connection_id = ${connection.id}
            AND source_type = 'TECHNICAL_METRIC'::"IngestionSourceType"
            AND sampled_at >= ${metricFloor}
            AND sampled_at < ${options.schedule.now}
          GROUP BY 1
          ORDER BY 1 ASC
        `;
    metricCoverage.push([connection.id, rows.map((row) => row.window_start)]);
  }
  const coverageByConnection = new Map(metricCoverage);
  const enrichedConnections = connections.map((connection) => ({
    ...connection,
    metricCoverageWindowStarts: coverageByConnection.get(connection.id) ?? [],
  }));
  const plan = buildIngestionSchedulePlan(enrichedConnections, options.schedule);
  const createdJobs: PrismaIngestionJobSchedulerRunResult['createdJobs'][number][] = [];
  if (options.apply) {
    for (const job of plan.jobs) {
      try {
        createdJobs.push(await tx.ingestionJob.create({
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
        }));
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        // Another scheduler can win the unique active-window race. Treat that
        // as an idempotent outcome instead of failing the whole cycle.
        const existing = await tx.ingestionJob.findFirst({
          where: {
            cloudConnectionId: job.cloudConnectionId,
            sourceType: job.sourceType,
            targetStart: job.targetStart,
            targetEnd: job.targetEnd,
            configurationHash: job.configurationHash,
            archivedAt: null,
            status: { in: ['PENDING', 'RUNNING'] },
          },
          select: { id: true },
        });
        if (existing === null) throw error;
      }
    }
  }

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

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

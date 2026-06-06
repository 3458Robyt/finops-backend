import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import {
  buildIngestionSchedulePlan,
  type IngestionScheduleOptions,
} from '../src/infrastructure/ingestion/ingestionJobScheduler.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.flags.has('apply');
  const prisma = getPrismaClient();
  const provider = args.values.get('provider');
  const connectionId = args.values.get('connection-id');
  const options = buildOptions(args.values);

  const connections = await prisma.cloudConnection.findMany({
    where: {
      providerCode: provider === undefined ? { in: ['aws', 'oci'] } : provider,
      status: 'ACTIVE',
      ...(connectionId !== undefined ? { id: connectionId } : {}),
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

  const plan = buildIngestionSchedulePlan(connections, options);
  const created = apply
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

  console.log(JSON.stringify({
    success: true,
    mode: apply ? 'apply' : 'dry-run',
    generatedAt: options.now.toISOString(),
    options: {
      metricWindowMinutes: options.metricWindowMinutes,
      metricCooldownMinutes: options.metricCooldownMinutes,
      billingWindowHours: options.billingWindowHours,
      billingCooldownHours: options.billingCooldownHours,
      maxAttempts: options.maxAttempts,
    },
    connectionsEvaluated: connections.length,
    plannedJobs: plan.jobs.map((job) => ({
      cloudConnectionId: job.cloudConnectionId,
      providerCode: job.providerCode,
      sourceType: job.sourceType,
      targetStart: job.targetStart,
      targetEnd: job.targetEnd,
      reason: job.reason,
    })),
    createdJobs: created,
    skipped: plan.skipped,
  }, null, 2));

  await prisma.$disconnect();
}

interface ParsedArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token?.startsWith('--') !== true) {
      continue;
    }

    const key = token.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.add(key);
      continue;
    }

    values.set(key, next);
    index += 1;
  }

  return { values, flags };
}

function buildOptions(values: ReadonlyMap<string, string>): IngestionScheduleOptions {
  return {
    now: parseDate(values.get('now') ?? new Date().toISOString(), 'now'),
    metricWindowMinutes: parsePositiveInteger(values.get('metric-window-minutes') ?? '30', 'metric-window-minutes'),
    metricCooldownMinutes: parsePositiveInteger(values.get('metric-cooldown-minutes') ?? '25', 'metric-cooldown-minutes'),
    billingWindowHours: parsePositiveInteger(values.get('billing-window-hours') ?? '24', 'billing-window-hours'),
    billingCooldownHours: parsePositiveInteger(values.get('billing-cooldown-hours') ?? '6', 'billing-cooldown-hours'),
    maxAttempts: parsePositiveInteger(values.get('max-attempts') ?? '1', 'max-attempts'),
  };
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be an ISO-8601 datetime`);
  }

  return parsed;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }

  return parsed;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

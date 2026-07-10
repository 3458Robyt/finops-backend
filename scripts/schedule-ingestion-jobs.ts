import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import type { IngestionScheduleOptions } from '../src/infrastructure/ingestion/ingestionJobScheduler.js';
import { runPrismaIngestionJobScheduler } from '../src/infrastructure/ingestion/PrismaIngestionJobScheduler.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.flags.has('apply');
  const prisma = getPrismaClient();
  const provider = args.values.get('provider');
  const connectionId = args.values.get('connection-id');
  const options = buildOptions(args.values);

  const result = await runPrismaIngestionJobScheduler(prisma, {
    apply,
    schedule: options,
    ...(provider !== undefined ? { providerCode: provider } : {}),
    ...(connectionId !== undefined ? { connectionId } : {}),
  });

  console.log(JSON.stringify({
    success: true,
    mode: result.mode,
    generatedAt: result.generatedAt.toISOString(),
    options: {
      metricWindowMinutes: options.metricWindowMinutes,
      metricCooldownMinutes: options.metricCooldownMinutes,
      billingWindowHours: options.billingWindowHours,
      billingCooldownHours: options.billingCooldownHours,
      maxAttempts: options.maxAttempts,
    },
    connectionsEvaluated: result.connectionsEvaluated,
    plannedJobs: result.plannedJobs,
    createdJobs: result.createdJobs,
    skipped: result.skipped,
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

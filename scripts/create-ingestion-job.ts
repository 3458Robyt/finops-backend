import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import type { IngestionSourceType } from '../src/generated/prisma/enums.js';

const allowedSourceTypes = ['BILLING_EXPORT', 'TECHNICAL_METRIC', 'INVENTORY'] as const satisfies readonly IngestionSourceType[];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = args.get('provider') ?? 'oci';
  const sourceType = parseSourceType(args.get('source-type') ?? 'TECHNICAL_METRIC');
  const hours = parsePositiveInteger(args.get('hours') ?? '24', 'hours');
  const maxAttempts = parsePositiveInteger(args.get('max-attempts') ?? '1', 'max-attempts');
  const connectionId = args.get('connection-id');
  const window = parseWindow(args, hours);
  const prisma = getPrismaClient();

  const connection = await prisma.cloudConnection.findFirstOrThrow({
    where: {
      ...(connectionId !== undefined ? { id: connectionId } : { providerCode: provider, status: 'ACTIVE' }),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, tenantId: true, providerCode: true },
  });

  const job = await prisma.ingestionJob.create({
    data: {
      tenantId: connection.tenantId,
      cloudConnectionId: connection.id,
      sourceType,
      targetStart: window.start,
      targetEnd: window.end,
      maxAttempts,
    },
    select: {
      id: true,
      cloudConnectionId: true,
      sourceType: true,
      status: true,
      targetStart: true,
      targetEnd: true,
    },
  });

  console.log(JSON.stringify({
    success: true,
    provider: connection.providerCode,
    job,
  }, null, 2));

  await prisma.$disconnect();
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const value = args[index + 1];
    if (token?.startsWith('--') === true && value !== undefined) {
      parsed.set(token.slice(2), value);
      index += 1;
    }
  }

  return parsed;
}

function parseSourceType(value: string): IngestionSourceType {
  if ((allowedSourceTypes as readonly string[]).includes(value)) {
    return value as IngestionSourceType;
  }

  throw new Error(`Unsupported source type ${value}. Use ${allowedSourceTypes.join(', ')}.`);
}

function parseWindow(args: ReadonlyMap<string, string>, hours: number): { readonly start: Date; readonly end: Date } {
  const startValue = args.get('start');
  const endValue = args.get('end');

  if (startValue === undefined && endValue === undefined) {
    const end = new Date();
    return {
      start: new Date(end.getTime() - hours * 60 * 60 * 1000),
      end,
    };
  }

  if (startValue === undefined || endValue === undefined) {
    throw new Error('Use --start and --end together, or omit both and use --hours.');
  }

  const start = parseDate(startValue, 'start');
  const end = parseDate(endValue, 'end');
  if (start >= end) {
    throw new Error('start must be before end');
  }

  return { start, end };
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

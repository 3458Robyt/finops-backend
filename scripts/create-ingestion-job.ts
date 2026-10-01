import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import type { IngestionSourceType } from '../src/generated/prisma/enums.js';
import { METRIC_STATISTICS, type MetricStatistic } from '../src/domain/interfaces/ICloudIngestionProvider.js';
import { runWithDatabaseContext } from '../src/infrastructure/database/tenantContext.js';
import { buildIngestionConfigurationHash } from '../src/infrastructure/ingestion/ingestionConfigurationHash.js';

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

  const { connection, job, reused } = await runWithDatabaseContext(
    { workerId: 'create-ingestion-job-cli', role: 'MASTER_ADMIN' },
    async () => {
      const connection = await prisma.cloudConnection.findFirstOrThrow({
        where: {
          ...(connectionId !== undefined ? { id: connectionId } : { providerCode: provider, status: 'ACTIVE' }),
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, tenantId: true, providerCode: true, metadata: true },
      });
      const metricFilter = sourceType === 'TECHNICAL_METRIC' ? parseMetricFilter(args) : undefined;
      if (sourceType !== 'TECHNICAL_METRIC' && hasMetricFilterArgs(args)) {
        throw new Error('Los filtros de métrica solo aplican a source-type TECHNICAL_METRIC.');
      }
      if (metricFilter !== undefined && connection.providerCode !== 'oci') {
        throw new Error('Los filtros selectivos de recuperación solo están implementados para OCI.');
      }
      const requestContext = sourceType === 'TECHNICAL_METRIC'
        ? {
          interval: '30m',
          resolutionSeconds: 1800,
          ...(metricFilter === undefined ? {} : {
            ...(metricFilter.regionId === undefined ? {} : { regionId: metricFilter.regionId }),
            metricFilter,
          }),
        }
        : undefined;
      const configurationHash = buildIngestionConfigurationHash({
        providerCode: connection.providerCode,
        sourceType,
        metadata: connection.metadata,
        ...(requestContext === undefined ? {} : { requestContext }),
      });

      const jobWhere = {
        cloudConnectionId: connection.id,
        sourceType,
        targetStart: window.start,
        targetEnd: window.end,
        configurationHash,
        archivedAt: null,
        status: { in: ['PENDING', 'RUNNING', 'SUCCESS'] as const },
      };
      const select = {
        id: true,
        cloudConnectionId: true,
        sourceType: true,
        status: true,
        targetStart: true,
        targetEnd: true,
        requestContext: true,
      } as const;
      const existing = await prisma.ingestionJob.findFirst({ where: jobWhere, orderBy: { createdAt: 'desc' }, select });
      if (existing !== null) return { connection, job: existing, reused: true };

      try {
        const job = await prisma.ingestionJob.create({
          data: {
            tenantId: connection.tenantId,
            cloudConnectionId: connection.id,
            sourceType,
            targetStart: window.start,
            targetEnd: window.end,
            maxAttempts,
            configurationHash,
            ...(requestContext === undefined ? {} : { requestContext }),
          },
          select,
        });
        return { connection, job, reused: false };
      } catch (error: unknown) {
        if (!isUniqueConstraintError(error)) throw error;
        const concurrent = await prisma.ingestionJob.findFirst({ where: jobWhere, orderBy: { createdAt: 'desc' }, select });
        if (concurrent === null) throw error;
        return { connection, job: concurrent, reused: true };
      }
    },
  );

  console.log(JSON.stringify({
    success: true,
    provider: connection.providerCode,
    ...(reused ? { reused: true, message: 'Ya existe un job para esta ventana y configuración; se devuelve el job existente.' } : { reused: false }),
    job,
  }, null, 2));

  await prisma.$disconnect();
}

function hasMetricFilterArgs(args: ReadonlyMap<string, string>): boolean {
  return ['metric-namespace', 'metric-name', 'resource-id', 'region-id', 'statistic'].some((key) => args.has(key));
}

function parseMetricFilter(args: ReadonlyMap<string, string>): {
  readonly namespace: string;
  readonly metricName: string;
  readonly resourceId: string;
  readonly regionId?: string;
  readonly statistic: MetricStatistic;
} | undefined {
  if (!hasMetricFilterArgs(args)) return undefined;
  const required = (key: string): string => {
    const value = args.get(key)?.trim();
    if (value === undefined || value === '') throw new Error(`--${key} es obligatorio cuando se filtra una métrica OCI.`);
    return value;
  };
  const statistic = required('statistic').toUpperCase();
  if (!(METRIC_STATISTICS as readonly string[]).includes(statistic)) {
    throw new Error(`--statistic debe ser uno de: ${METRIC_STATISTICS.join(', ')}.`);
  }
  const regionId = args.get('region-id')?.trim();
  return {
    namespace: required('metric-namespace'),
    metricName: required('metric-name'),
    resourceId: required('resource-id'),
    ...(regionId === undefined || regionId === '' ? {} : { regionId }),
    statistic: statistic as MetricStatistic,
  };
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

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

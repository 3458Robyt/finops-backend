import 'dotenv/config';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CloudIngestionJobContext, MetricStatistic } from '../../src/domain/interfaces/ICloudIngestionProvider.js';
import { getPrismaClient } from '../../src/infrastructure/database/prisma.js';
import { runWithDatabaseContext } from '../../src/infrastructure/database/tenantContext.js';
import { CredentialCipher } from '../../src/infrastructure/security/CredentialCipher.js';
import { PrismaIngestionJobSupport } from '../../src/infrastructure/ingestion/PrismaIngestionJobSupport.js';
import { OciSdkIngestionProvider } from '../../src/infrastructure/ingestion/OciSdkIngestionProvider.js';
import { readOciMetricDefinitions } from '../../src/infrastructure/ingestion/oci/OciMonitoringCollector.js';
import type { OciMetricDefinition } from '../../src/infrastructure/ingestion/oci/OciSdkContracts.js';
import { safeOciProviderError } from '../../src/infrastructure/ingestion/oci/OciCapabilityValidator.js';

const statistics = new Set<MetricStatistic>(['MEAN', 'MIN', 'MAX', 'P50', 'P90', 'P95', 'P99', 'SUM', 'COUNT', 'RATE', 'LATEST']);

interface Arguments {
  readonly jobId: string;
  readonly start: Date;
  readonly end: Date;
  readonly metricName?: string;
  readonly namespace?: string;
  readonly resourceId?: string;
  readonly statistic: MetricStatistic;
  readonly regionId?: string;
  readonly compartmentId?: string;
  readonly interval: '5m' | '30m' | '1h';
  readonly timeoutMs: number;
  readonly output: string;
}

const args = readArguments(process.argv.slice(2));
const prisma = getPrismaClient();

try {
  const source = await runWithDatabaseContext(
    { role: 'MASTER_ADMIN', workerId: 'testing:oci-gap-readonly-canary' },
    async () => {
      const support = new PrismaIngestionJobSupport(
        prisma,
        new CredentialCipher(process.env['CREDENTIAL_ENCRYPTION_KEY'], process.env['CREDENTIAL_KEY_VERSION'] ?? 'v1'),
      );
      const record = await support.findJobContext(args.jobId);
      if (record === null) throw new Error(`No existe el job ${args.jobId}.`);
      return support.toJobContext(record);
    },
  );

  const job = buildReadOnlyJob(source, args);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const result = await new OciSdkIngestionProvider().collect(job, { signal: controller.signal });
    const summary = await summarizeResult(result);
    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'read-only',
      persisted: false,
      jobId: args.jobId,
      connectionId: job.cloudConnectionId,
      tenantId: job.tenantId,
      candidate: {
        namespace: args.namespace ?? 'from-definition',
        metricName: args.metricName ?? 'from-definition',
        resourceId: args.resourceId ?? 'from-definition',
        statistic: args.statistic,
        regionId: args.regionId ?? job.connection.defaultRegion ?? 'default',
        interval: args.interval,
        start: args.start.toISOString(),
        end: args.end.toISOString(),
      },
      provider: {
        apiCallCount: result.apiCallCount,
        warnings: result.warnings,
        coverage: result.coverage,
        ...summary,
      },
    };
    await mkdir(dirname(resolve(args.output)), { recursive: true });
    await writeFile(resolve(args.output), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearTimeout(timeout);
  }
} catch (error: unknown) {
  console.error(`OCI gap canary failed: ${safeOciProviderError(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

function buildReadOnlyJob(source: CloudIngestionJobContext, input: Arguments): CloudIngestionJobContext {
  const definitions = readOciMetricDefinitions(source);
  const matching = definitions.find((definition) => (
    (input.metricName === undefined || definition.metricName === input.metricName)
      && (input.namespace === undefined || definition.namespace === input.namespace)
      && (input.resourceId === undefined || definition.resourceId === input.resourceId)
      && (input.regionId === undefined || definition.regionId === input.regionId)
  ));
  if (matching === undefined) {
    throw new Error('No hay una definición OCI habilitada que coincida con el candidato solicitado.');
  }
  const selected: OciMetricDefinition = {
    ...matching,
    ...(input.compartmentId === undefined ? {} : { compartmentId: input.compartmentId }),
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
    ...(input.metricName === undefined ? {} : { metricName: input.metricName }),
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    ...(input.regionId === undefined ? {} : { regionId: input.regionId }),
    statistics: [input.statistic],
  };
  const metadata = isRecord(source.connection.metadata) ? { ...source.connection.metadata } : {};
  metadata['ociMetricDefinitions'] = [selected];
  return {
    ...source,
    id: `readonly-gap-${Date.now().toString(36)}`,
    targetStart: input.start,
    targetEnd: input.end,
    requestContext: {
      ...(source.requestContext ?? {}),
      interval: input.interval,
      ...(input.regionId === undefined ? {} : { regionId: input.regionId }),
    },
    connection: { ...source.connection, metadata },
  };
}

async function summarizeResult(result: Awaited<ReturnType<OciSdkIngestionProvider['collect']>>): Promise<Record<string, unknown>> {
  let samples = 0;
  let minValue: number | undefined;
  let maxValue: number | undefined;
  let firstSampledAt: Date | undefined;
  let lastSampledAt: Date | undefined;
  if (result.metricBatches !== undefined) {
    for await (const batch of result.metricBatches) {
      for (const sample of batch) {
        samples += 1;
        minValue = minValue === undefined ? sample.value : Math.min(minValue, sample.value);
        maxValue = maxValue === undefined ? sample.value : Math.max(maxValue, sample.value);
        firstSampledAt = firstSampledAt === undefined || sample.sampledAt < firstSampledAt ? sample.sampledAt : firstSampledAt;
        lastSampledAt = lastSampledAt === undefined || sample.sampledAt > lastSampledAt ? sample.sampledAt : lastSampledAt;
      }
    }
  }
  return {
    returnedSamples: samples,
    ...(minValue === undefined ? {} : { minValue, maxValue }),
    ...(firstSampledAt === undefined ? {} : { firstSampledAt: firstSampledAt.toISOString(), lastSampledAt: lastSampledAt?.toISOString() }),
  };
}

function readArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help') {
      console.log('Use --job-id <SUCCESS_JOB> --start <ISO> --end <ISO> [--metric-name ... --resource-id ... --statistic P95].');
      process.exit(0);
    }
    if (argv[index]?.startsWith('--') && argv[index + 1] !== undefined) values.set(argv[index]!.slice(2), argv[index + 1]!);
  }
  const jobId = required(values, 'job-id');
  const start = parseDate(required(values, 'start'), 'start');
  const end = parseDate(required(values, 'end'), 'end');
  const interval = values.get('interval') ?? '30m';
  if (end <= start || end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) throw new Error('El canary admite una ventana de 24 horas como máximo.');
  if (interval !== '5m' && interval !== '30m' && interval !== '1h') throw new Error('--interval debe ser 5m, 30m o 1h.');
  const statistic = (values.get('statistic') ?? 'P95').toUpperCase() as MetricStatistic;
  if (!statistics.has(statistic)) throw new Error('--statistic no está soportada.');
  const timeoutMs = Number(values.get('timeout-ms') ?? '120000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('--timeout-ms debe estar entre 1000 y 300000.');
  return {
    jobId, start, end, statistic, interval, timeoutMs,
    ...(values.get('metric-name') === undefined ? {} : { metricName: values.get('metric-name') }),
    ...(values.get('namespace') === undefined ? {} : { namespace: values.get('namespace') }),
    ...(values.get('resource-id') === undefined ? {} : { resourceId: values.get('resource-id') }),
    ...(values.get('region-id') === undefined ? {} : { regionId: values.get('region-id') }),
    ...(values.get('compartment-id') === undefined ? {} : { compartmentId: values.get('compartment-id') }),
    output: values.get('out') ?? `.test-artifacts/oci-gap-canary-${Date.now()}.json`,
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (value === undefined || value === '') throw new Error(`Falta --${key}.`);
  return value;
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--${field} debe ser ISO-8601.`);
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

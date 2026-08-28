import 'dotenv/config';
import { Prisma } from '../src/generated/prisma/client.js';
import { buildIngestionConfigurationHash } from '../src/infrastructure/ingestion/ingestionConfigurationHash.js';
import { PrismaMetricCoveragePersistence } from '../src/infrastructure/ingestion/PrismaMetricCoveragePersistence.js';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { runWithDatabaseContext } from '../src/infrastructure/database/tenantContext.js';

/**
 * Rebuilds daily technical-metric coverage for one explicit connection range.
 * The command is intentionally bounded and never mutates without --apply.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tenantId = requiredArgument(args, '--tenant');
  const cloudConnectionId = requiredArgument(args, '--connection-id');
  const targetStart = parseDate(requiredArgument(args, '--start'), '--start');
  const targetEnd = parseDate(requiredArgument(args, '--end'), '--end');
  const granularitySeconds = parseGranularity(args);
  const apply = args.includes('--apply');

  if (targetStart >= targetEnd) throw new Error('--start debe ser anterior a --end.');
  const maximumRangeMs = 91 * 24 * 60 * 60 * 1000;
  if (targetEnd.getTime() - targetStart.getTime() > maximumRangeMs) {
    throw new Error('El rango máximo de reconstrucción es de 91 días. Divide la operación en tramos explícitos.');
  }

  const prisma = getPrismaClient();
  try {
    const result = await runWithDatabaseContext(
      { tenantId, role: 'MASTER_ADMIN', workerId: 'maintenance:metric-coverage' },
      async () => {
        const connection = await prisma.cloudConnection.findFirst({
          where: { id: cloudConnectionId, tenantId, status: 'ACTIVE' },
          select: { id: true, providerCode: true, metadata: true },
        });
        if (connection === null) throw new Error('No existe una conexión activa para ese tenant e identificador.');

        const rawCounts = await prisma.$queryRaw<readonly [{ readonly samples: bigint; readonly definitions: bigint }]>(Prisma.sql`
          SELECT
            (SELECT count(*)::bigint FROM resource_metric_samples
             WHERE tenant_id = ${tenantId} AND cloud_connection_id = ${cloudConnectionId}
               AND source_type = 'TECHNICAL_METRIC'::"IngestionSourceType"
               AND sampled_at >= ${targetStart} AND sampled_at < ${targetEnd}) AS samples,
            (SELECT count(*)::bigint FROM cloud_metric_definitions
             WHERE tenant_id = ${tenantId} AND cloud_connection_id = ${cloudConnectionId} AND enabled = true) AS definitions
        `);
        const configurationHash = readConfigurationHash(args) ?? buildIngestionConfigurationHash({
          providerCode: connection.providerCode,
          sourceType: 'TECHNICAL_METRIC',
          metadata: connection.metadata,
          requestContext: { interval: '30m', resolutionSeconds: granularitySeconds },
        });

        if (!apply) {
          return {
            mode: 'dry-run' as const,
            samples: Number(rawCounts[0]?.samples ?? 0n),
            definitions: Number(rawCounts[0]?.definitions ?? 0n),
            configurationHash,
          };
        }

        const affected = await prisma.$transaction(
          (tx) => new PrismaMetricCoveragePersistence().refreshForConnectionRange(tx, {
            tenantId,
            cloudConnectionId,
            targetStart,
            targetEnd,
            configurationHash,
            defaultGranularitySeconds: granularitySeconds,
          }),
          { maxWait: 10_000, timeout: 300_000 },
        );
        return {
          mode: 'apply' as const,
          affected,
          samples: Number(rawCounts[0]?.samples ?? 0n),
          definitions: Number(rawCounts[0]?.definitions ?? 0n),
          configurationHash,
        };
      },
    );

    console.log(JSON.stringify({
      event: 'metric_coverage_rebuilt',
      tenantId,
      cloudConnectionId,
      start: targetStart.toISOString(),
      end: targetEnd.toISOString(),
      granularitySeconds,
      ...result,
    }));
  } finally {
    await prisma.$disconnect();
  }
}

function requiredArgument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`Falta ${name}. Usa --tenant, --connection-id, --start y --end.`);
  }
  return value.trim();
}

function parseDate(value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} no contiene una fecha ISO válida.`);
  return date;
}

function parseGranularity(args: readonly string[]): number {
  const index = args.indexOf('--granularity-seconds');
  if (index < 0) return 1800;
  const value = Number(args[index + 1]);
  if (![1800, 3600, 86400].includes(value)) {
    throw new Error('--granularity-seconds debe ser 1800, 3600 o 86400.');
  }
  return value;
}

function readConfigurationHash(args: readonly string[]): string | undefined {
  const index = args.indexOf('--configuration-hash');
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (value === undefined || value === '') return undefined;
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('--configuration-hash debe ser un SHA-256 hexadecimal.');
  return value;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'No se pudo reconstruir la cobertura técnica.');
  process.exitCode = 1;
});

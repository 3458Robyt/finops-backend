import 'dotenv/config';

import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { runWithDatabaseContext } from '../src/infrastructure/database/tenantContext.js';
import { assertLocalFinopsDatabaseTarget } from '../src/infrastructure/database/assertLocalMutationTarget.js';
import { normalizeExternalResourceId } from '../src/domain/models/ResourceLinkage.js';
import { PrismaMetricCoveragePersistence } from '../src/infrastructure/ingestion/PrismaMetricCoveragePersistence.js';
import { readOciMetricFilter, type OciMetricFilter } from '../src/infrastructure/ingestion/oci/OciMetricDefinitionFilter.js';
import type { ResourceMetricCoverageWindow } from '../src/generated/prisma/client.js';

/** Rebuilds only derived coverage rows owned by one successful filtered OCI job. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assertLocalFinopsDatabaseTarget(process.env['DATABASE_URL']);
  const tenantId = requiredArgument(args, '--tenant');
  const cloudConnectionId = requiredArgument(args, '--connection-id');
  const ingestionJobId = requiredArgument(args, '--job-id');
  const apply = args.includes('--apply');
  const prisma = getPrismaClient();

  try {
    const result = await runWithDatabaseContext(
      { tenantId, role: 'MASTER_ADMIN', workerId: 'maintenance:filtered-metric-coverage' },
      async () => {
        const connection = await prisma.cloudConnection.findFirst({
          where: { id: cloudConnectionId, tenantId, status: 'ACTIVE' },
          select: { providerCode: true },
        });
        if (connection?.providerCode.toLowerCase() !== 'oci') {
          throw new Error('La conexión debe existir, estar activa y ser OCI.');
        }

        const job = await prisma.ingestionJob.findFirst({
          where: {
            id: ingestionJobId,
            tenantId,
            cloudConnectionId,
            sourceType: 'TECHNICAL_METRIC',
            status: 'SUCCESS',
          },
          select: { targetStart: true, targetEnd: true, requestContext: true, projectionStatus: true },
        });
        if (job === null) throw new Error('El job debe ser exitoso y pertenecer a la conexión/tenant indicados.');
        if (job.projectionStatus === 'PENDING' || job.projectionStatus === 'RUNNING') {
          throw new Error('El job tiene una proyección activa o en cola; espera a que termine antes de reproyectar.');
        }
        if (job.targetEnd.getTime() <= job.targetStart.getTime()
          || job.targetEnd.getTime() - job.targetStart.getTime() > 91 * 24 * 60 * 60 * 1000) {
          throw new Error('El job tiene un rango inválido o superior a 91 días.');
        }

        const filter = readOciMetricFilter(asRequestContext(job.requestContext));
        if (filter === undefined) throw new Error('El job debe contener requestContext.metricFilter.');
        const where = { tenantId, cloudConnectionId, ingestionJobId } as const;
        const before = await prisma.resourceMetricCoverageWindow.findMany({
          where,
          select: coverageFields,
        });
        const outOfFilterBefore = countOutOfFilter(before, filter);
        const rawSamples = await prisma.resourceMetricSample.count({
          where: {
            tenantId,
            cloudConnectionId,
            sourceType: 'TECHNICAL_METRIC',
            sampledAt: { gte: job.targetStart, lt: job.targetEnd },
          },
        });

        if (!apply) {
          return {
            mode: 'dry-run' as const,
            filter: describeFilter(filter),
            projectionStatus: job.projectionStatus,
            coverageRowsBefore: before.length,
            rowsOutsideFilterBefore: outOfFilterBefore,
            rawSamplesInJobRange: rawSamples,
          };
        }

        return prisma.$transaction(async (tx) => {
          const rawSamplesBefore = await tx.resourceMetricSample.count({
            where: {
              tenantId,
              cloudConnectionId,
              sourceType: 'TECHNICAL_METRIC',
              sampledAt: { gte: job.targetStart, lt: job.targetEnd },
            },
          });
          const affected = await new PrismaMetricCoveragePersistence().refreshForJob(tx, ingestionJobId);
          const after = await tx.resourceMetricCoverageWindow.findMany({ where, select: coverageFields });
          const outOfFilterAfter = countOutOfFilter(after, filter);
          const rawSamplesAfter = await tx.resourceMetricSample.count({
            where: {
              tenantId,
              cloudConnectionId,
              sourceType: 'TECHNICAL_METRIC',
              sampledAt: { gte: job.targetStart, lt: job.targetEnd },
            },
          });

          if (outOfFilterAfter > 0 || (before.length > 0 && after.length === 0)) {
            throw new Error('La cobertura reconstruida no pasó las invariantes; la transacción se revertirá.');
          }
          if (rawSamplesBefore !== rawSamplesAfter || rawSamplesAfter !== rawSamples) {
            throw new Error('Cambió la cantidad de muestras crudas; la transacción se revertirá.');
          }

          return {
            mode: 'applied' as const,
            filter: describeFilter(filter),
            coverageRowsBefore: before.length,
            rowsOutsideFilterBefore: outOfFilterBefore,
            coverageRowsAfter: after.length,
            rowsOutsideFilterAfter: outOfFilterAfter,
            affected,
            rawSamplesBefore: rawSamplesBefore,
            rawSamplesAfter,
          };
        }, { maxWait: 10_000, timeout: 120_000 });
      },
    );

    console.log(JSON.stringify({ event: 'filtered_metric_coverage_reprojection', ...result }));
  } finally {
    await prisma.$disconnect();
  }
}

const coverageFields = {
  providerNamespace: true,
  regionId: true,
  externalResourceId: true,
  metricName: true,
  statistic: true,
} as const;

function countOutOfFilter(
  rows: readonly Pick<ResourceMetricCoverageWindow, keyof typeof coverageFields>[],
  filter: OciMetricFilter,
): number {
  return rows.filter((row) => (
    (filter.namespace !== undefined && row.providerNamespace !== filter.namespace)
    || (filter.metricName !== undefined && row.metricName !== filter.metricName)
    || (filter.resourceId !== undefined
      && normalizeExternalResourceId(row.externalResourceId) !== normalizeExternalResourceId(filter.resourceId))
    || (filter.regionId !== undefined && row.regionId !== filter.regionId)
    || (filter.statistic !== undefined && row.statistic !== filter.statistic)
  )).length;
}

function asRequestContext(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function describeFilter(filter: OciMetricFilter): Readonly<Record<string, string | boolean>> {
  return {
    ...(filter.namespace === undefined ? {} : { namespace: filter.namespace }),
    ...(filter.metricName === undefined ? {} : { metricName: filter.metricName }),
    ...(filter.regionId === undefined ? {} : { regionId: filter.regionId }),
    ...(filter.statistic === undefined ? {} : { statistic: filter.statistic }),
    resourceScoped: filter.resourceId !== undefined,
  };
}

function requiredArgument(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`Falta ${name}. Usa --tenant, --connection-id y --job-id.`);
  }
  return value.trim();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'No se pudo reconstruir la cobertura filtrada.');
  process.exitCode = 1;
});

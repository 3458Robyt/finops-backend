import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { PrismaResourceMetricRollupPersistence } from '../src/infrastructure/repositories/PrismaResourceMetricRollupPersistence.js';

/** Rebuilds peak-aware metric rollups from canonical raw samples. */
async function main(): Promise<void> {
  const tenantId = readTenantId(process.argv.slice(2));
  const prisma = getPrismaClient();
  try {
    const affected = await new PrismaResourceMetricRollupPersistence().refreshAll(prisma, tenantId);
    console.log(JSON.stringify({ event: 'resource_metric_rollups_rebuilt', tenantId: tenantId ?? null, affected }));
  } finally {
    await prisma.$disconnect();
  }
}

function readTenantId(args: readonly string[]): string | undefined {
  const index = args.indexOf('--tenant');
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'No se pudieron reconstruir los rollups de métricas.');
  process.exitCode = 1;
});

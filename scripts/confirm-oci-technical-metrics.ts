import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';

/** Enables only discovered OCI metric streams that belong to the current inventory. */
async function main(): Promise<void> {
  const connectionId = requiredArgument('--connection-id');
  const dryRun = hasFlag('--dry-run');
  const prisma = getPrismaClient();

  try {
    const connection = await prisma.cloudConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, tenantId: true, providerCode: true },
    });
    if (connection === null) throw new Error('The indicated cloud connection does not exist.');
    if (connection.providerCode !== 'oci') throw new Error('The indicated connection is not OCI.');

    const resources = await prisma.cloudResource.findMany({
      where: { cloudConnectionId: connectionId },
      select: { externalResourceId: true },
    });
    const resourceIds = [...new Set(resources.map((resource) => resource.externalResourceId).filter(Boolean))];
    if (resourceIds.length === 0) throw new Error('No inventory resources exist for this connection. Run inventory first.');

    const candidates = await prisma.cloudMetricDefinition.findMany({
      where: {
        tenantId: connection.tenantId,
        cloudConnectionId: connectionId,
        enabled: false,
        externalResourceId: { in: resourceIds },
      },
      select: { id: true, namespace: true, metricName: true, externalResourceId: true, regionId: true },
      orderBy: [{ namespace: 'asc' }, { metricName: 'asc' }],
    });

    if (!dryRun && candidates.length > 0) {
      await prisma.cloudMetricDefinition.updateMany({
        where: { id: { in: candidates.map((candidate) => candidate.id) } },
        data: { enabled: true, status: 'CONFIRMED', confirmedAt: new Date(), lastSeenAt: new Date() },
      });
    }

    console.log(JSON.stringify({
      success: true,
      mode: dryRun ? 'dry-run' : 'confirmed-current-inventory',
      connectionId,
      inventoryResources: resourceIds.length,
      confirmedDefinitions: candidates.length,
      namespaces: summarize(candidates.map((candidate) => candidate.namespace)),
      metricNames: summarize(candidates.map((candidate) => candidate.metricName)),
      regions: summarize(candidates.map((candidate) => candidate.regionId ?? 'UNKNOWN')),
      warning: 'Only streams with a non-empty resource identifier and a matching cloud_resources row were enabled.',
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

function summarize(values: readonly string[]): Readonly<Record<string, number>> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.trim() === '') throw new Error(`Missing required argument ${name}.`);
  return value.trim();
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

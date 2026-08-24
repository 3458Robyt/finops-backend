import 'dotenv/config';
import { createHash } from 'node:crypto';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';
import { PrismaCloudConnectionRepository } from '../src/infrastructure/repositories/PrismaCloudConnectionRepository.js';
import { OciSdkIngestionProvider } from '../src/infrastructure/ingestion/OciSdkIngestionProvider.js';
import type { OciMetricDefinition } from '../src/infrastructure/ingestion/oci/OciSdkContracts.js';
import { Prisma } from '../src/generated/prisma/client.js';

/** Discovers OCI metric streams and, only with --persist, stores them disabled. */
async function main(): Promise<void> {
  const connectionId = readRequiredArgument('--connection-id');
  const prisma = getPrismaClient();
  const connection = await prisma.cloudConnection.findUnique({
    where: { id: connectionId },
    select: { tenantId: true, providerCode: true, status: true },
  });
  if (connection === null) throw new Error('La conexión indicada no existe.');
  if (connection.providerCode !== 'oci') throw new Error('La conexión indicada no es OCI.');
  if (connection.status !== 'ACTIVE') throw new Error('La conexión OCI debe estar ACTIVE.');

  const repository = new PrismaCloudConnectionRepository(
    prisma,
    new CredentialCipher(process.env.CREDENTIAL_ENCRYPTION_KEY, process.env.CREDENTIAL_KEY_VERSION ?? 'v1'),
  );
  const ingestionConnection = await repository.getIngestionConnectionForTenant(connection.tenantId, connectionId);
  if (ingestionConnection === null) throw new Error('No existe una credencial OCI activa para la conexión.');

  const result = await new OciSdkIngestionProvider().discoverMetricDefinitions(ingestionConnection);
  if (hasFlag('--persist')) await persistCandidates(prisma, ingestionConnection.tenantId, connectionId, result.definitions, result.regions);

  console.log(JSON.stringify({
    success: true,
    mode: hasFlag('--persist') ? 'persisted-disabled' : 'preview',
    connectionId,
    regions: result.regions,
    compartments: result.compartments.length,
    apiCallCount: result.apiCallCount,
    definitions: result.definitions.length,
    warnings: result.warnings,
    candidates: summarizeCandidates(result.definitions),
  }, null, 2));
  await prisma.$disconnect();
}

async function persistCandidates(
  prisma: ReturnType<typeof getPrismaClient>,
  tenantId: string,
  connectionId: string,
  definitions: readonly OciMetricDefinition[],
  regions: readonly string[],
): Promise<void> {
  const now = new Date();
  await prisma.cloudConnectionRegion.createMany({
    data: regions.map((regionId) => ({
      tenantId,
      cloudConnectionId: connectionId,
      regionId,
      subscribed: true,
      status: 'DISCOVERED',
      firstSeenAt: now,
      lastSeenAt: now,
    })),
    skipDuplicates: true,
  });
  await prisma.cloudConnectionRegion.updateMany({
    where: { cloudConnectionId: connectionId, regionId: { in: [...regions] } },
    data: { subscribed: true, lastSeenAt: now },
  });

  const data = definitions.map((definition) => {
    const dimensions = definition.dimensions === undefined
      ? undefined
      : definition.dimensions as Prisma.InputJsonValue;
    return {
      tenantId,
      cloudConnectionId: connectionId,
      ...(definition.regionId === undefined ? {} : { regionId: definition.regionId }),
      compartmentId: definition.compartmentId,
      namespace: definition.namespace,
      metricName: definition.metricName,
      externalResourceId: definition.resourceId,
      ...(dimensions === undefined ? {} : { dimensions }),
      dimensionsHash: hashDimensions(definition.dimensions ?? {}),
      ...(definition.unit === undefined ? {} : { metricUnit: definition.unit }),
      statistics: [...(definition.statistics ?? ['MEAN'])] as Prisma.InputJsonValue,
      status: 'DISCOVERED',
      enabled: false,
      discoverySource: 'OCI_LIST_METRICS',
      firstSeenAt: now,
      lastSeenAt: now,
    };
  });
  if (data.length > 0) {
    await prisma.cloudMetricDefinition.createMany({ data, skipDuplicates: true });
    for (const chunk of chunked(data, 100)) {
      await prisma.cloudMetricDefinition.updateMany({
        where: {
          cloudConnectionId: connectionId,
          OR: chunk.map((definition) => ({
            namespace: definition.namespace,
            metricName: definition.metricName,
            compartmentId: definition.compartmentId,
            externalResourceId: definition.externalResourceId,
            dimensionsHash: definition.dimensionsHash,
          })),
        },
        data: { lastSeenAt: now },
      });
    }
  }
}

function chunked<T>(items: readonly T[], size: number): readonly T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push([...items.slice(index, index + size)]);
  return chunks;
}

function summarizeCandidates(definitions: readonly OciMetricDefinition[]): readonly Record<string, unknown>[] {
  return definitions.slice(0, 100).map((definition) => ({
    regionId: definition.regionId,
    compartmentId: definition.compartmentId,
    namespace: definition.namespace,
    metricName: definition.metricName,
    resourceId: definition.resourceId,
    unit: definition.unit,
    statistics: definition.statistics,
  }));
}

function hashDimensions(dimensions: Readonly<Record<string, string>>): string {
  const canonical = Object.keys(dimensions).sort().map((key) => `${key}=${dimensions[key]}`).join('&');
  return createHash('sha256').update(canonical).digest('hex');
}

function readRequiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--')) throw new Error(`Pass ${name} <value>.`);
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

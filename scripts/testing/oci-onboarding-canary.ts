import 'dotenv/config';
import { getPrismaClient } from '../../src/infrastructure/database/prisma.js';
import { OciSdkIngestionProvider } from '../../src/infrastructure/ingestion/OciSdkIngestionProvider.js';
import { PrismaCloudConnectionRepository } from '../../src/infrastructure/repositories/PrismaCloudConnectionRepository.js';
import { CredentialCipher } from '../../src/infrastructure/security/CredentialCipher.js';
import type { CloudIngestionJobContext } from '../../src/domain/interfaces/ICloudIngestionProvider.js';

const prisma = getPrismaClient();
const startedAt = Date.now();

try {
  const selectedId = process.argv[2];
  const row = await prisma.cloudConnection.findFirstOrThrow({
    where: {
      ...(selectedId !== undefined ? { id: selectedId } : {}),
      providerCode: 'oci',
      status: 'ACTIVE',
    },
    select: { id: true, tenantId: true },
  });
  const repository = new PrismaCloudConnectionRepository(prisma, new CredentialCipher());
  const connection = await repository.getIngestionConnectionForTenant(row.tenantId, row.id);
  if (connection === null) throw new Error('La conexión OCI activa no está disponible.');

  const provider = new OciSdkIngestionProvider();
  const validation = await provider.validate(connection);
  const readinessBefore = await repository.listIngestionReadinessForTenant(row.tenantId);
  const inventoryStartedAt = Date.now();
  const inventoryJob: CloudIngestionJobContext = {
    id: `canary-inventory-${Date.now()}`,
    tenantId: row.tenantId,
    cloudConnectionId: row.id,
    sourceType: 'INVENTORY',
    targetStart: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    targetEnd: new Date(),
    attempt: 1,
    connection,
  };
  const inventory = await provider.collect(inventoryJob);
  const inventoryMs = Date.now() - inventoryStartedAt;
  const previewStartedAt = Date.now();
  const focusPreview = await provider.previewFocus(connection, 5);
  const focusPreviewMs = Date.now() - previewStartedAt;
  const readinessStartedAt = Date.now();
  const readinessAfter = await repository.listIngestionReadinessForTenant(row.tenantId);
  const readinessJson = JSON.stringify(readinessAfter);
  console.log(JSON.stringify({
    connectionId: row.id,
    durationMs: Date.now() - startedAt,
    readinessMs: Date.now() - readinessStartedAt,
    readinessBytes: Buffer.byteLength(readinessJson),
    onboardingStatusBefore: readinessBefore.connections.find((item) => item.id === row.id)?.onboardingStatus,
    onboardingStatusAfter: readinessAfter.connections.find((item) => item.id === row.id)?.onboardingStatus,
    inventoryReadOnly: {
      durationMs: inventoryMs,
      apiCallCount: inventory.apiCallCount,
      resources: inventory.resources.length,
      sampleResources: inventory.resources.slice(0, 5).map((resource) => ({
        externalResourceId: resource.externalResourceId,
        resourceType: resource.resourceType,
        serviceName: resource.serviceName,
        regionId: resource.regionId,
      })),
      warnings: inventory.warnings,
    },
    focusPreview: {
      durationMs: focusPreviewMs,
      configuredLocations: focusPreview.configuredLocations,
      discoveredObjects: focusPreview.discoveredObjects,
      returnedObjects: focusPreview.objects.length,
      approximateBytes: focusPreview.approximateBytes,
      sizedObjects: focusPreview.sizedObjects,
      errors: focusPreview.errors,
    },
    capabilities: validation.capabilities.map(({ capability, status, message }) => ({ capability, status, message })),
  }, null, 2));
} finally {
  await prisma.$disconnect();
}

// OCI's SDK may leave transport timers referenced after read-only calls.
// All clients are already closed by the provider; force this one-shot canary to terminate promptly.
process.exit(0);

import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';
import { PrismaCloudConnectionRepository } from '../src/infrastructure/repositories/PrismaCloudConnectionRepository.js';
import { CloudConnectionService } from '../src/application/services/CloudConnectionService.js';
import { OciSdkIngestionProvider } from '../src/infrastructure/ingestion/OciSdkIngestionProvider.js';

async function main(): Promise<void> {
  const connectionId = readRequiredArgument('--connection-id');
  const prisma = getPrismaClient();
  const connection = await prisma.cloudConnection.findUnique({
    where: { id: connectionId },
    select: { tenantId: true, providerCode: true },
  });
  if (connection === null) throw new Error('La conexión indicada no existe.');
  if (connection.providerCode !== 'oci') throw new Error('La conexión indicada no es OCI.');

  const service = new CloudConnectionService(
    new PrismaCloudConnectionRepository(
      prisma,
      new CredentialCipher(process.env.CREDENTIAL_ENCRYPTION_KEY, process.env.CREDENTIAL_KEY_VERSION ?? 'v1'),
    ),
    [new OciSdkIngestionProvider()],
  );
  const result = await service.validateConnection({
    tenantId: connection.tenantId,
    cloudConnectionId: connectionId,
  });
  console.log(JSON.stringify({
    success: true,
    connectionId,
    providerCode: result.providerCode,
    authentication: result.authentication?.status,
    capabilities: result.capabilities.map((capability) => ({
      capability: capability.capability,
      status: capability.status,
      message: capability.message,
    })),
  }, null, 2));
}

function readRequiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--')) {
    throw new Error(`Pass ${name} <value>.`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { loadRuntimeConfig } from '../src/infrastructure/config/runtimeConfigReader.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';
import { PrismaCloudConnectionRepository } from '../src/infrastructure/repositories/PrismaCloudConnectionRepository.js';
import { CloudConnectionService } from '../src/application/services/CloudConnectionService.js';
import { OciSdkIngestionProvider } from '../src/infrastructure/ingestion/OciSdkIngestionProvider.js';

async function main(): Promise<void> {
  const connectionId = readRequiredArgument('--connection-id') ?? readPositionalConnectionId();
  if (connectionId === undefined) throw new Error('Pass --connection-id <value> or a connection id as the first argument.');
  const requestedCredentialId = readOptionalArgument('--credential-id');
  const config = loadRuntimeConfig();
  const prisma = getPrismaClient(config.database);

  try {
    const connection = await prisma.cloudConnection.findFirst({
      where: { id: connectionId, providerCode: 'oci' },
      select: { id: true, tenantId: true },
    });
    if (connection === null) throw new Error('La conexión OCI indicada no existe.');

    const repository = new PrismaCloudConnectionRepository(
      prisma,
      new CredentialCipher(config.security.credentialEncryptionKey, config.security.credentialKeyVersion),
    );
    const credentials = await repository.listCredentialSummaries(connection.tenantId, connection.id);
    const candidate = requestedCredentialId === undefined
      ? credentials?.find((item) => item.status === 'PENDING' || item.status === 'INVALID')
      : credentials?.find((item) => item.id === requestedCredentialId);
    if (candidate === undefined) {
      throw new Error('No existe una credencial OCI PENDING o INVALID para validar.');
    }

    const service = new CloudConnectionService(repository, [new OciSdkIngestionProvider()]);
    const result = await service.validateCredential({
      tenantId: connection.tenantId,
      cloudConnectionId: connection.id,
      credentialId: candidate.id,
    });

    console.log(JSON.stringify({
      success: true,
      connectionId: connection.id,
      credentialId: result.credential.id,
      credentialStatus: result.credential.status,
      validationStatus: result.credential.validationStatus,
      authentication: result.validation.authentication?.status,
      capabilities: result.validation.capabilities.map(({ capability, status }) => ({ capability, status })),
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

function readRequiredArgument(name: string): string | undefined {
  return readOptionalArgument(name);
}

function readOptionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  return index < 0 || value === undefined || value.startsWith('--') ? undefined : value;
}

function readPositionalConnectionId(): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith('--')) {
      index += 1;
      continue;
    }
    return args[index];
  }
  return undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

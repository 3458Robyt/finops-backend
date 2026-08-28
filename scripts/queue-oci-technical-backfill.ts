import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';
import { PrismaCloudConnectionRepository } from '../src/infrastructure/repositories/PrismaCloudConnectionRepository.js';
import { CloudConnectionService } from '../src/application/services/CloudConnectionService.js';
import { runWithDatabaseContext } from '../src/infrastructure/database/tenantContext.js';

async function main(): Promise<void> {
  const connectionId = readRequiredArgument('--connection-id');
  const lookbackDays = readNumberArgument('--lookback-days', 90);
  const windowHours = readNumberArgument('--window-hours', 24);
  const prisma = getPrismaClient();
  const workerContext = { workerId: 'ingestion-backfill-cli', role: 'MASTER_ADMIN' as const };
  const connection = await runWithDatabaseContext(workerContext, () => prisma.cloudConnection.findUnique({
    where: { id: connectionId },
    select: { tenantId: true, providerCode: true, status: true },
  }));
  if (connection === null) throw new Error('La conexión indicada no existe.');
  if (connection.providerCode !== 'oci') throw new Error('La conexión indicada no es OCI.');
  if (connection.status !== 'ACTIVE') throw new Error('La conexión OCI debe estar ACTIVE.');

  const service = new CloudConnectionService(
    new PrismaCloudConnectionRepository(
      prisma,
      new CredentialCipher(process.env.CREDENTIAL_ENCRYPTION_KEY, process.env.CREDENTIAL_KEY_VERSION ?? 'v1'),
    ),
  );
  const result = await runWithDatabaseContext(
    { ...workerContext, tenantId: connection.tenantId },
    () => service.queueTechnicalMetricBackfill({
      tenantId: connection.tenantId,
      cloudConnectionId: connectionId,
      lookbackDays,
      windowHours,
    }),
  );
  console.log(JSON.stringify({
    success: true,
    connectionId,
    lookbackDays: result.lookbackDays,
    rangeStart: result.rangeStart,
    rangeEnd: result.rangeEnd,
    createdJobs: result.createdJobs.length,
    skippedWindows: result.skippedWindows.length,
    estimatedApiCalls: result.estimatedApiCalls,
    jobIds: result.createdJobs.map((job) => job.id),
  }, null, 2));
}

function readRequiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--')) throw new Error(`Pass ${name} <value>.`);
  return value;
}

function readNumberArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} debe ser numérico.`);
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

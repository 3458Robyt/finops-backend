import 'dotenv/config';
import { CloudIngestionWorkerService } from '../src/application/services/CloudIngestionWorkerService.js';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { AwsSdkIngestionProvider } from '../src/infrastructure/ingestion/AwsSdkIngestionProvider.js';
import { OciSdkIngestionProvider } from '../src/infrastructure/ingestion/OciSdkIngestionProvider.js';
import { PrismaCloudIngestionJobRepository } from '../src/infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const prisma = getPrismaClient();
  const workerId = process.env['INGESTION_WORKER_ID'] ?? `manual-worker-${process.pid}`;
  const worker = new CloudIngestionWorkerService(
    new PrismaCloudIngestionJobRepository(prisma, new CredentialCipher()),
    [
      new AwsSdkIngestionProvider(),
      new OciSdkIngestionProvider(),
    ],
  );

  const result = await worker.runOnce(workerId);
  const durationMs = Date.now() - startedAt;

  console.log(JSON.stringify({
    durationMs,
    result,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

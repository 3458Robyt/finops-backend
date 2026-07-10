import 'dotenv/config';
import { CloudIngestionWorkerService } from '../src/application/services/CloudIngestionWorkerService.js';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { AwsSdkIngestionProvider } from '../src/infrastructure/ingestion/AwsSdkIngestionProvider.js';
import { OciSdkIngestionProvider } from '../src/infrastructure/ingestion/OciSdkIngestionProvider.js';
import { PrismaCloudIngestionJobRepository } from '../src/infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';

async function main(): Promise<void> {
  if (process.argv.includes('--preflight')) {
    printPreflight();
    return;
  }

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

function printPreflight(): void {
  const checks = {
    DATABASE_URL: isConfigured(process.env['DATABASE_URL']),
    CREDENTIAL_ENCRYPTION_KEY: isValidCredentialKey(process.env['CREDENTIAL_ENCRYPTION_KEY']),
  };

  console.log(JSON.stringify({
    ok: Object.values(checks).every(Boolean),
    checks,
    commands: {
      generateCredentialKey: 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      runOnce: 'npm run ingestion:worker:once',
    },
  }, null, 2));
}

function isConfigured(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function isValidCredentialKey(value: string | undefined): boolean {
  if (!isConfigured(value)) {
    return false;
  }

  return Buffer.from(value, 'base64').length === 32;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

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
  const concurrency = readConcurrency();
  const worker = new CloudIngestionWorkerService(
    new PrismaCloudIngestionJobRepository(
      prisma,
      new CredentialCipher(process.env['CREDENTIAL_ENCRYPTION_KEY'], process.env['CREDENTIAL_KEY_VERSION'] ?? 'v1'),
    ),
    [
      new AwsSdkIngestionProvider(),
      new OciSdkIngestionProvider(),
    ],
  );

  const result = await worker.runBatch(workerId, concurrency);
  const durationMs = Date.now() - startedAt;

  console.log(JSON.stringify({
    durationMs,
    concurrency,
    result,
  }, null, 2));
}

function readConcurrency(): number {
  const index = process.argv.indexOf('--concurrency');
  const raw = index >= 0 ? process.argv[index + 1] : process.env['INGESTION_WORKER_CONCURRENCY'] ?? '1';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error('concurrency debe ser un entero entre 1 y 16.');
  }
  return value;
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

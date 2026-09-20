import 'dotenv/config';
import { CloudIngestionWorkerService } from '../src/application/services/CloudIngestionWorkerService.js';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { AwsSdkIngestionProvider } from '../src/infrastructure/ingestion/AwsSdkIngestionProvider.js';
import { OciSdkIngestionProvider } from '../src/infrastructure/ingestion/OciSdkIngestionProvider.js';
import { PrismaCloudIngestionJobRepository } from '../src/infrastructure/ingestion/PrismaCloudIngestionJobRepository.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';
import { assertLocalMutationTarget } from '../src/infrastructure/database/assertLocalMutationTarget.js';

async function main(): Promise<void> {
  assertLocalMutationTarget(process.env['DATABASE_URL']);
  const cloudConnectionId = readOptionalArgument('--connection-id');
  const sourceType = readSourceType();
  const concurrency = readConcurrency();
  if (isFlagSet('--preflight')) {
    printPreflight({ cloudConnectionId, sourceType, concurrency });
    return;
  }

  const startedAt = Date.now();
  const prisma = getPrismaClient();
  const workerId = process.env['INGESTION_WORKER_ID'] ?? `manual-worker-${process.pid}`;
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

  try {
    const result = await worker.runBatch(workerId, concurrency, cloudConnectionId, sourceType);
    const durationMs = Date.now() - startedAt;

    console.log(JSON.stringify({
      durationMs,
      concurrency,
      ...(cloudConnectionId === undefined ? {} : { cloudConnectionId }),
      ...(sourceType === undefined ? {} : { sourceType }),
      result,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

function readOptionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const npmConfigName = `npm_config_${name.replace(/^--/, '').replaceAll('-', '_')}`;
  const npmConfigValue = process.env[npmConfigName];
  const value = index >= 0
    ? process.argv[index + 1]
    : (npmConfigValue !== undefined && npmConfigValue !== 'true'
      ? npmConfigValue
      : npmPassthroughValue(npmArgumentIndex(name)));
  if (value === undefined) return undefined;
  if (value === undefined || value.startsWith('--') || value.trim() === '') {
    throw new Error(`${name} requiere un valor.`);
  }
  return value.trim();
}

function readSourceType(): 'BILLING_EXPORT' | 'TECHNICAL_METRIC' | 'INVENTORY' | undefined {
  const value = readOptionalArgument('--source-type');
  if (value === undefined) return undefined;
  if (value !== 'BILLING_EXPORT' && value !== 'TECHNICAL_METRIC' && value !== 'INVENTORY') {
    throw new Error('--source-type debe ser BILLING_EXPORT, TECHNICAL_METRIC o INVENTORY.');
  }
  return value;
}

function readConcurrency(): number {
  const index = process.argv.indexOf('--concurrency');
  const raw = index >= 0
    ? process.argv[index + 1]
    : (process.env['npm_config_concurrency'] !== undefined && process.env['npm_config_concurrency'] !== 'true'
      ? process.env['npm_config_concurrency']
      : npmPassthroughValue(2) ?? process.env['INGESTION_WORKER_CONCURRENCY'] ?? '1');
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new Error('concurrency debe ser un entero entre 1 y 16.');
  }
  return value;
}

function isFlagSet(name: string): boolean {
  const configName = `npm_config_${name.replace(/^--/, '').replaceAll('-', '_')}`;
  return process.argv.includes(name) || process.env[configName] === 'true';
}

function npmArgumentIndex(name: string): number | undefined {
  if (name === '--connection-id') return 0;
  if (name === '--source-type') return 1;
  return undefined;
}

function npmPassthroughValue(index: number | undefined): string | undefined {
  if (index === undefined || process.env['npm_lifecycle_event'] === undefined) return undefined;
  const values = process.argv.slice(2).filter((value) => !value.startsWith('--'));
  return values[index];
}

function printPreflight(request: {
  readonly cloudConnectionId: string | undefined;
  readonly sourceType: 'BILLING_EXPORT' | 'TECHNICAL_METRIC' | 'INVENTORY' | undefined;
  readonly concurrency: number;
}): void {
  const checks = {
    DATABASE_URL: isConfigured(process.env['DATABASE_URL']),
    CREDENTIAL_ENCRYPTION_KEY: isValidCredentialKey(process.env['CREDENTIAL_ENCRYPTION_KEY']),
  };

  console.log(JSON.stringify({
    ok: Object.values(checks).every(Boolean),
    checks,
    request,
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

import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import type { ProviderCode } from '../src/domain/models/CloudConnection.js';
import { configureFocusSourceMetadata, type FocusSourceMode } from '../src/infrastructure/ingestion/focusSourceMetadata.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = parseProvider(args.get('provider') ?? 'oci');
  const mode = parseMode(args.get('mode') ?? 'location');
  const connectionId = args.get('connection-id') ?? await findDefaultConnectionId(provider);
  const prisma = getPrismaClient();
  const connection = await prisma.cloudConnection.findUniqueOrThrow({
    where: { id: connectionId },
    select: { id: true, providerCode: true, metadata: true },
  });

  if (connection.providerCode !== provider) {
    throw new Error(`Connection ${connectionId} is ${connection.providerCode}, not ${provider}`);
  }

  const result = configureFocusSourceMetadata({
    provider,
    mode,
    values: args,
    existingMetadata: isRecord(connection.metadata) ? connection.metadata : {},
    replace: args.has('replace'),
  });

  await prisma.cloudConnection.update({
    where: { id: connectionId },
    data: { metadata: result.metadata },
  });

  console.log(JSON.stringify({
    success: true,
    connectionId,
    provider,
    mode,
    updatedKey: result.updatedKey,
    configuredCount: result.configuredCount,
    replaced: args.has('replace'),
  }, null, 2));

  await prisma.$disconnect();
}

async function findDefaultConnectionId(provider: ProviderCode): Promise<string> {
  const prisma = getPrismaClient();
  const connection = await prisma.cloudConnection.findFirst({
    where: { providerCode: provider, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (connection === null) {
    throw new Error(`No active ${provider.toUpperCase()} cloud connection found. Pass --connection-id.`);
  }

  return connection.id;
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const value = args[index + 1];
    if (token?.startsWith('--') !== true) {
      continue;
    }

    const key = token.slice(2);
    if (key === 'replace') {
      parsed.set(key, 'true');
      continue;
    }

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }

    parsed.set(key, value);
    index += 1;
  }

  return parsed;
}

function parseProvider(value: string): ProviderCode {
  if (value === 'aws' || value === 'oci') {
    return value;
  }

  throw new Error('provider must be aws or oci');
}

function parseMode(value: string): FocusSourceMode {
  if (value === 'location' || value === 'object') {
    return value;
  }

  throw new Error('mode must be location or object');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

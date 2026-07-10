import 'dotenv/config';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import type { CredentialPurpose } from '../src/generated/prisma/enums.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';

const allowedPurposes = ['OPERATIONAL', 'BILLING_EXPORT_READ', 'METRICS_READ', 'STORAGE_READ'] as const satisfies readonly CredentialPurpose[];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionId = args.get('connection-id') ?? await findDefaultAwsConnectionId();
  const roleArn = requireArg(args, 'role-arn');
  const externalId = args.get('external-id');
  const sessionName = args.get('session-name') ?? 'finops-ingestion-worker';
  const region = args.get('region') ?? 'us-east-1';
  const purpose = parsePurpose(args.get('purpose') ?? 'OPERATIONAL');
  const label = args.get('label') ?? `AWS role ${purpose}`;
  const cipher = new CredentialCipher();
  const encrypted = cipher.encrypt({
    roleArn,
    region,
    sessionName,
    ...(externalId !== undefined ? { externalId } : {}),
  });
  const prisma = getPrismaClient();

  await prisma.$transaction(async (tx) => {
    await tx.cloudConnectionCredential.updateMany({
      where: {
        cloudConnectionId: connectionId,
        purpose,
        status: 'ACTIVE',
        label,
      },
      data: {
        status: 'DISABLED',
        disabledAt: new Date(),
      },
    });

    await tx.cloudConnectionCredential.create({
      data: {
        cloudConnectionId: connectionId,
        purpose,
        status: 'ACTIVE',
        label,
        encryptedPayload: encrypted.encryptedPayload,
        encryptionIv: encrypted.encryptionIv,
        encryptionAuthTag: encrypted.encryptionAuthTag,
        encryptionAlgorithm: encrypted.encryptionAlgorithm,
        encryptionKeyVersion: encrypted.encryptionKeyVersion,
        externalPrincipalId: roleArn,
      },
    });
  });

  console.log(JSON.stringify({
    success: true,
    connectionId,
    purpose,
    roleArn,
    credentialStored: true,
    externalIdConfigured: externalId !== undefined,
  }, null, 2));

  await prisma.$disconnect();
}

async function findDefaultAwsConnectionId(): Promise<string> {
  const prisma = getPrismaClient();
  const connection = await prisma.cloudConnection.findFirst({
    where: { providerCode: 'aws', status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (connection === null) {
    throw new Error('No active AWS cloud connection found. Pass --connection-id.');
  }

  return connection.id;
}

function parseArgs(args: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const value = args[index + 1];
    if (token?.startsWith('--') === true && value !== undefined) {
      parsed.set(token.slice(2), value);
      index += 1;
    }
  }

  return parsed;
}

function parsePurpose(value: string): CredentialPurpose {
  if ((allowedPurposes as readonly string[]).includes(value)) {
    return value as CredentialPurpose;
  }

  throw new Error(`Unsupported purpose ${value}. Use ${allowedPurposes.join(', ')}.`);
}

function requireArg(args: ReadonlyMap<string, string>, name: string): string {
  const value = args.get(name);
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required --${name}`);
  }

  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

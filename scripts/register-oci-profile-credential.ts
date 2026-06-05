import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import { CredentialCipher } from '../src/infrastructure/security/CredentialCipher.js';

interface OciProfile {
  readonly userId: string;
  readonly fingerprint: string;
  readonly tenancyId: string;
  readonly region: string;
  readonly keyFile: string;
}

interface MetricSummaryRow {
  readonly namespace?: string;
  readonly metric?: string;
  readonly resourceId?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const profileName = args.get('profile') ?? 'FINOPS_READER';
  const connectionId = args.get('connection-id') ?? await findDefaultOciConnectionId();
  const summarySeriesPath = args.get('summary-series');
  const profile = await readOciProfile(profileName, args.get('config'));
  const privateKey = await readFile(profile.keyFile, 'utf8');
  const cipher = new CredentialCipher();
  const encrypted = cipher.encrypt({
    tenancyId: profile.tenancyId,
    userId: profile.userId,
    fingerprint: profile.fingerprint,
    privateKey,
    region: profile.region,
  });
  const prisma = getPrismaClient();

  await prisma.$transaction(async (tx) => {
    await tx.cloudConnectionCredential.updateMany({
      where: {
        cloudConnectionId: connectionId,
        purpose: 'OPERATIONAL',
        status: 'ACTIVE',
        label: `OCI profile ${profileName}`,
      },
      data: {
        status: 'DISABLED',
        disabledAt: new Date(),
      },
    });

    await tx.cloudConnectionCredential.create({
      data: {
        cloudConnectionId: connectionId,
        purpose: 'OPERATIONAL',
        status: 'ACTIVE',
        label: `OCI profile ${profileName}`,
        encryptedPayload: encrypted.encryptedPayload,
        encryptionIv: encrypted.encryptionIv,
        encryptionAuthTag: encrypted.encryptionAuthTag,
        encryptionAlgorithm: encrypted.encryptionAlgorithm,
        encryptionKeyVersion: encrypted.encryptionKeyVersion,
        externalPrincipalId: profile.userId,
      },
    });

    if (summarySeriesPath !== undefined) {
      const current = await tx.cloudConnection.findUniqueOrThrow({
        where: { id: connectionId },
        select: { metadata: true, rootExternalId: true },
      });
      const mergedMetadata = {
        ...(isRecord(current.metadata) ? current.metadata : {}),
        ociMetricDefinitions: await buildMetricDefinitions(summarySeriesPath, current.rootExternalId),
      };

      await tx.cloudConnection.update({
        where: { id: connectionId },
        data: { metadata: mergedMetadata },
      });
    }
  });

  console.log(JSON.stringify({
    success: true,
    connectionId,
    profile: profileName,
    operationalCredentialStored: true,
    metadataUpdated: summarySeriesPath !== undefined,
  }, null, 2));
}

async function findDefaultOciConnectionId(): Promise<string> {
  const prisma = getPrismaClient();
  const connection = await prisma.cloudConnection.findFirst({
    where: { providerCode: 'oci', status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (connection === null) {
    throw new Error('No active OCI cloud connection found. Pass --connection-id.');
  }

  return connection.id;
}

async function readOciProfile(profileName: string, configPath?: string): Promise<OciProfile> {
  const resolvedConfigPath = configPath ?? path.join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.oci', 'config');
  const text = await readFile(resolvedConfigPath, 'utf8');
  const values = parseIniProfile(text, profileName);
  const keyFile = requireValue(values, 'key_file').replace(/^~/, process.env['USERPROFILE'] ?? process.env['HOME'] ?? '');

  return {
    userId: requireValue(values, 'user'),
    fingerprint: requireValue(values, 'fingerprint'),
    tenancyId: requireValue(values, 'tenancy'),
    region: requireValue(values, 'region'),
    keyFile,
  };
}

function parseIniProfile(text: string, profileName: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  let inProfile = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const section = /^\[(.+)]$/.exec(line);
    if (section !== null) {
      inProfile = section[1] === profileName;
      continue;
    }

    if (!inProfile) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex > 0) {
      values.set(line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim());
    }
  }

  return values;
}

async function buildMetricDefinitions(
  summarySeriesPath: string,
  compartmentId: string,
): Promise<readonly Record<string, string>[]> {
  const text = await readFile(summarySeriesPath, 'utf8');
  const rows = JSON.parse(text) as MetricSummaryRow[];
  const seen = new Set<string>();
  const definitions: Record<string, string>[] = [];

  for (const row of rows) {
    if (row.namespace === undefined || row.metric === undefined || row.resourceId === undefined) {
      continue;
    }

    const key = `${row.namespace}:${row.metric}:${row.resourceId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    definitions.push({
      compartmentId,
      namespace: row.namespace,
      metricName: row.metric,
      resourceId: row.resourceId,
      query: `${row.metric}[30m]{resourceId = "${row.resourceId}"}.mean()`,
    });
  }

  return definitions;
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

function requireValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === '') {
    throw new Error(`OCI profile is missing ${key}`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

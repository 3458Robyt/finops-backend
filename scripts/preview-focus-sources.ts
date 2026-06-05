import 'dotenv/config';
import * as oci from 'oci-sdk';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@smithy/types';
import { getPrismaClient } from '../src/infrastructure/database/prisma.js';
import type { CloudIngestionCredential } from '../src/domain/interfaces/ICloudIngestionProvider.js';
import type { ProviderCode } from '../src/domain/models/CloudConnection.js';
import { readFocusSourcePreviewConfig, isFocusObjectName, type PreviewObject } from '../src/infrastructure/ingestion/focusSourcePreview.js';
import { getCredential, optionalString, requireString } from '../src/infrastructure/ingestion/providerConfig.js';
import { CredentialCipher, type EncryptedCredentialPayload } from '../src/infrastructure/security/CredentialCipher.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = parseProvider(args.get('provider') ?? 'oci');
  const connection = await loadConnection(args.get('connection-id') ?? await findDefaultConnectionId(provider));
  if (connection.providerCode !== provider) {
    throw new Error(`Connection ${connection.id} is ${connection.providerCode}, not ${provider}`);
  }

  const config = readFocusSourcePreviewConfig(provider, connection.metadata);
  const discovered = provider === 'aws'
    ? await previewAws(connection, config.locations.filter((location) => location.provider === 'aws'))
    : await previewOci(connection, config.locations.filter((location) => location.provider === 'oci'));
  const configuredObjects = config.configuredObjects;
  const objects = [...configuredObjects, ...discovered].slice(0, readLimit(args.get('limit')));

  console.log(JSON.stringify({
    success: true,
    provider,
    connectionId: connection.id,
    configuredObjects: configuredObjects.length,
    configuredLocations: config.locations.length,
    discoveredObjects: discovered.length,
    returnedObjects: objects.length,
    objects,
  }, null, 2));
}

async function previewAws(
  connection: LoadedConnection,
  locations: readonly Extract<ReturnType<typeof readFocusSourcePreviewConfig>['locations'][number], { provider: 'aws' }>[],
): Promise<readonly PreviewObject[]> {
  const credential = getCredential(connection.credentials, ['BILLING_EXPORT_READ', 'STORAGE_READ', 'OPERATIONAL']);
  if (credential === undefined) {
    throw new Error('AWS BILLING_EXPORT_READ, STORAGE_READ or OPERATIONAL credential is required');
  }

  const baseRegion = connection.defaultRegion ?? 'us-east-1';
  const credentials = await assumeAwsRole(credential, baseRegion);
  const objects: PreviewObject[] = [];

  for (const location of locations) {
    const client = new S3Client({
      region: location.region ?? baseRegion,
      credentials,
      maxAttempts: 2,
    });
    let continuationToken: string | undefined;

    while (objects.length < location.maxObjects) {
      const response = await client.send(new ListObjectsV2Command({
        Bucket: location.bucket,
        Prefix: location.prefix,
        MaxKeys: Math.min(1000, location.maxObjects - objects.length),
        ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
      }));

      for (const object of response.Contents ?? []) {
        if (object.Key === undefined || !isFocusObjectName(object.Key)) {
          continue;
        }

        objects.push({
          provider: 'aws',
          source: 'discovered',
          bucket: location.bucket,
          key: object.Key,
          focusVersion: location.focusVersion,
          ...(location.region !== undefined ? { region: location.region } : {}),
        });
      }

      if (response.IsTruncated !== true || response.NextContinuationToken === undefined) {
        break;
      }
      continuationToken = response.NextContinuationToken;
    }
  }

  return objects;
}

async function previewOci(
  connection: LoadedConnection,
  locations: readonly Extract<ReturnType<typeof readFocusSourcePreviewConfig>['locations'][number], { provider: 'oci' }>[],
): Promise<readonly PreviewObject[]> {
  const client = new oci.objectstorage.ObjectStorageClient({
    authenticationDetailsProvider: createOciAuthProvider(connection),
  });
  const objects: PreviewObject[] = [];

  for (const location of locations) {
    let start: string | undefined;

    while (objects.length < location.maxObjects) {
      const response = await client.listObjects({
        namespaceName: location.namespaceName,
        bucketName: location.bucketName,
        prefix: location.prefix,
        limit: Math.min(1000, location.maxObjects - objects.length),
        ...(start !== undefined ? { start } : {}),
      });

      for (const object of response.listObjects?.objects ?? []) {
        if (object.name === undefined || !isFocusObjectName(object.name)) {
          continue;
        }

        objects.push({
          provider: 'oci',
          source: 'discovered',
          namespaceName: location.namespaceName,
          bucketName: location.bucketName,
          objectName: object.name,
          focusVersion: location.focusVersion,
        });
      }

      if (response.listObjects?.nextStartWith === undefined) {
        break;
      }
      start = response.listObjects.nextStartWith;
    }
  }

  return objects;
}

async function assumeAwsRole(
  credential: CloudIngestionCredential,
  region: string,
): Promise<AwsCredentialIdentity> {
  const roleArn = requireString(credential.payload['roleArn'], 'AWS roleArn');
  const externalId = optionalString(credential.payload['externalId']);
  const sessionName = optionalString(credential.payload['sessionName']) ?? 'finops-ingestion-preview';
  const client = new STSClient({ region, maxAttempts: 2 });
  const response = await client.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    ...(externalId !== undefined ? { ExternalId: externalId } : {}),
    DurationSeconds: 3600,
  }));

  if (
    response.Credentials?.AccessKeyId === undefined ||
    response.Credentials.SecretAccessKey === undefined ||
    response.Credentials.SessionToken === undefined
  ) {
    throw new Error('AWS STS AssumeRole did not return complete credentials');
  }

  return {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken,
  };
}

function createOciAuthProvider(connection: LoadedConnection): oci.common.AuthenticationDetailsProvider {
  const credential = getCredential(connection.credentials, ['BILLING_EXPORT_READ', 'STORAGE_READ', 'OPERATIONAL']);
  if (credential === undefined) {
    throw new Error('OCI BILLING_EXPORT_READ, STORAGE_READ or OPERATIONAL credential is required');
  }

  const regionId = optionalString(credential.payload['region']) ?? connection.defaultRegion ?? 'sa-bogota-1';
  return new oci.common.SimpleAuthenticationDetailsProvider(
    requireString(credential.payload['tenancyId'], 'OCI tenancyId'),
    requireString(credential.payload['userId'], 'OCI userId'),
    requireString(credential.payload['fingerprint'], 'OCI fingerprint'),
    requireString(credential.payload['privateKey'], 'OCI privateKey'),
    optionalString(credential.payload['passphrase']) ?? null,
    oci.common.Region.fromRegionId(regionId),
  );
}

interface LoadedConnection {
  readonly id: string;
  readonly providerCode: ProviderCode;
  readonly defaultRegion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly credentials: readonly CloudIngestionCredential[];
}

async function loadConnection(connectionId: string): Promise<LoadedConnection> {
  const prisma = getPrismaClient();
  const cipher = new CredentialCipher();
  const connection = await prisma.cloudConnection.findUniqueOrThrow({
    where: { id: connectionId },
    include: {
      credentials: {
        where: {
          status: 'ACTIVE',
          purpose: { not: 'TEMPORARY_ADMIN' },
        },
      },
    },
  });

  return {
    id: connection.id,
    providerCode: connection.providerCode,
    ...(connection.defaultRegion !== null ? { defaultRegion: connection.defaultRegion } : {}),
    ...(isRecord(connection.metadata) ? { metadata: connection.metadata } : {}),
    credentials: connection.credentials.map((credential): CloudIngestionCredential => ({
      purpose: credential.purpose,
      payload: cipher.decrypt({
        encryptedPayload: credential.encryptedPayload,
        encryptionIv: credential.encryptionIv,
        encryptionAuthTag: credential.encryptionAuthTag,
        encryptionAlgorithm: 'aes-256-gcm',
        encryptionKeyVersion: credential.encryptionKeyVersion,
      } satisfies EncryptedCredentialPayload),
      ...(credential.externalPrincipalId !== null ? { externalPrincipalId: credential.externalPrincipalId } : {}),
    })),
  };
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
    if (token?.startsWith('--') === true && value !== undefined) {
      parsed.set(token.slice(2), value);
      index += 1;
    }
  }

  return parsed;
}

function parseProvider(value: string): ProviderCode {
  if (value === 'aws' || value === 'oci') {
    return value;
  }

  throw new Error('provider must be aws or oci');
}

function readLimit(value: string | undefined): number {
  if (value === undefined) {
    return 100;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

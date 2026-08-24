import type {
  CloudCredentialSummary,
  StoreCloudCredentialInput,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type { CloudIngestionConnection } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { isJsonObject } from './mappers/cloudConnectionMappers.js';
import { CredentialCipher } from '../security/CredentialCipher.js';
import { ConfigurationError } from '../../domain/errors/errors.js';
import { invalidatedValidationData } from './cloudConnectionMetadata.js';

export class PrismaCloudCredentialRepository {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialCipher?: CredentialCipher,
  ) {}

  public async listCredentialSummaries(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<readonly CloudCredentialSummary[] | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: { id: cloudConnectionId, tenantId },
      select: {
        credentials: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            purpose: true,
            status: true,
            label: true,
            externalPrincipalId: true,
            keyFingerprint: true,
            createdAt: true,
            disabledAt: true,
            revokedAt: true,
            validationStatus: true,
            validationMessage: true,
            validationAttemptedAt: true,
          },
        },
      },
    });

    return connection === null
      ? null
      : connection.credentials
        .filter((credential) => credential.purpose !== 'TEMPORARY_ADMIN' && credential.purpose !== 'STORAGE_WRITE')
        .map(mapCredentialSummary);
  }

  public async storeCredential(
    input: StoreCloudCredentialInput,
  ): Promise<CloudCredentialSummary | null> {
    const encrypted = this.requireCredentialCipher().encrypt(input.payload);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const connection = await tx.cloudConnection.findFirst({
          where: { id: input.cloudConnectionId, tenantId: input.tenantId },
          select: { id: true, metadata: true },
        });
        if (connection === null) return null;

        const existing = input.keyFingerprint === undefined
          ? null
          : await tx.cloudConnectionCredential.findFirst({
            where: {
              cloudConnectionId: connection.id,
              purpose: input.purpose,
              keyFingerprint: input.keyFingerprint,
              status: { in: ['PENDING', 'ACTIVE', 'INVALID'] },
              ...(input.externalPrincipalId === undefined ? {} : { externalPrincipalId: input.externalPrincipalId }),
            },
            orderBy: { createdAt: 'desc' },
          });
        if (existing !== null) return { ...mapCredentialSummary(existing), reused: true };

        const credential = await tx.cloudConnectionCredential.create({
          data: {
            cloudConnectionId: connection.id,
            purpose: input.purpose,
            status: input.initialStatus ?? 'PENDING',
            label: input.label,
            ...encrypted,
            ...(input.externalPrincipalId === undefined ? {} : { externalPrincipalId: input.externalPrincipalId }),
            ...(input.keyFingerprint === undefined ? {} : { keyFingerprint: input.keyFingerprint }),
          },
        });
        await tx.cloudConnection.update({
          where: { id: connection.id },
          data: invalidatedValidationData(connection.metadata),
        });

        return { ...mapCredentialSummary(credential), reused: false };
      });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error) || input.keyFingerprint === undefined) throw error;
      const existing = await this.prisma.cloudConnectionCredential.findFirst({
        where: {
          cloudConnectionId: input.cloudConnectionId,
          purpose: input.purpose,
          keyFingerprint: input.keyFingerprint,
          status: { in: ['PENDING', 'ACTIVE', 'INVALID'] },
          cloudConnection: { tenantId: input.tenantId },
          ...(input.externalPrincipalId === undefined ? {} : { externalPrincipalId: input.externalPrincipalId }),
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing === null) throw error;
      return { ...mapCredentialSummary(existing), reused: true };
    }
  }

  public async revokeCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
  ): Promise<CloudCredentialSummary | null> {
    const credential = await this.prisma.cloudConnectionCredential.findFirst({
      where: {
        id: credentialId,
        cloudConnectionId,
        cloudConnection: { tenantId },
      },
      include: { cloudConnection: { select: { metadata: true } } },
    });
    if (credential === null) return null;

    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.cloudConnectionCredential.update({
        where: { id: credential.id },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      if (credential.status === 'ACTIVE') {
        await tx.cloudConnection.update({
          where: { id: cloudConnectionId },
          data: invalidatedValidationData(credential.cloudConnection.metadata),
        });
      }
      return mapCredentialSummary(revoked);
    });
  }

  public async getIngestionConnectionForTenant(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudIngestionConnection | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: { id: cloudConnectionId, tenantId, status: 'ACTIVE' },
      include: {
        credentials: {
          where: {
            status: 'ACTIVE',
            purpose: { notIn: ['TEMPORARY_ADMIN', 'STORAGE_WRITE'] },
          },
        },
        metricDefinitions: {
          where: { enabled: true },
          select: {
            compartmentId: true,
            namespace: true,
            metricName: true,
            externalResourceId: true,
            regionId: true,
            dimensions: true,
            metricUnit: true,
            statistics: true,
          },
        },
      },
    });
    if (connection === null) return null;

    const metadata = mergeEnabledMetricDefinitions(connection.metadata, connection.metricDefinitions);
    return {
      id: connection.id,
      tenantId: connection.tenantId,
      providerCode: connection.providerCode,
      rootExternalId: connection.rootExternalId,
      ...(connection.defaultRegion === null ? {} : { defaultRegion: connection.defaultRegion }),
      ...(metadata === undefined ? {} : { metadata }),
      credentials: connection.credentials.map((credential) => ({
        purpose: credential.purpose as CloudIngestionConnection['credentials'][number]['purpose'],
        payload: this.requireCredentialCipher().decrypt({
          encryptedPayload: credential.encryptedPayload,
          encryptionIv: credential.encryptionIv,
          encryptionAuthTag: credential.encryptionAuthTag,
          encryptionAlgorithm: 'aes-256-gcm',
          encryptionKeyVersion: credential.encryptionKeyVersion,
        }),
        ...(credential.externalPrincipalId === null ? {} : { externalPrincipalId: credential.externalPrincipalId }),
      })),
    };
  }

  public async getIngestionConnectionForCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
  ): Promise<CloudIngestionConnection | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: { id: cloudConnectionId, tenantId, status: 'ACTIVE' },
      include: {
        credentials: {
          where: {
            id: credentialId,
            purpose: { notIn: ['TEMPORARY_ADMIN', 'STORAGE_WRITE'] },
            status: { in: ['PENDING', 'ACTIVE', 'INVALID'] },
          },
        },
      },
    });
    if (connection === null || connection.credentials.length === 0) return null;

    return {
      id: connection.id,
      tenantId: connection.tenantId,
      providerCode: connection.providerCode,
      rootExternalId: connection.rootExternalId,
      ...(connection.defaultRegion === null ? {} : { defaultRegion: connection.defaultRegion }),
      ...(isJsonObject(connection.metadata) ? { metadata: connection.metadata as Record<string, unknown> } : {}),
      credentials: connection.credentials.map((credential) => ({
        purpose: credential.purpose as CloudIngestionConnection['credentials'][number]['purpose'],
        payload: this.requireCredentialCipher().decrypt({
          encryptedPayload: credential.encryptedPayload,
          encryptionIv: credential.encryptionIv,
          encryptionAuthTag: credential.encryptionAuthTag,
          encryptionAlgorithm: 'aes-256-gcm',
          encryptionKeyVersion: credential.encryptionKeyVersion,
        }),
        ...(credential.externalPrincipalId === null ? {} : { externalPrincipalId: credential.externalPrincipalId }),
      })),
    };
  }

  public async promoteCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
  ): Promise<CloudCredentialSummary | null> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.cloudConnectionCredential.findFirst({
        where: {
          id: credentialId,
          cloudConnectionId,
          cloudConnection: { tenantId },
          status: { in: ['PENDING', 'INVALID'] },
        },
        include: { cloudConnection: { select: { metadata: true } } },
      });
      if (candidate === null) return null;

      await tx.cloudConnectionCredential.updateMany({
        where: {
          cloudConnectionId,
          purpose: candidate.purpose,
          status: 'ACTIVE',
        },
        data: { status: 'DISABLED', disabledAt: new Date() },
      });

      const promoted = await tx.cloudConnectionCredential.update({
        where: { id: candidate.id },
        data: {
          status: 'ACTIVE',
          validationStatus: 'VERIFIED',
          validationMessage: null,
          disabledAt: null,
        },
      });
      await tx.cloudConnection.update({
        where: { id: cloudConnectionId },
        data: invalidatedValidationData(candidate.cloudConnection.metadata),
      });
      return mapCredentialSummary(promoted);
    });
  }

  public async updateCredentialValidation(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
    status: 'PENDING' | 'INVALID',
    validationStatus: 'VERIFIED' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NOT_CONFIGURED',
    message: string,
    attemptedAt: Date,
  ): Promise<CloudCredentialSummary | null> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.cloudConnectionCredential.findFirst({
        where: {
          id: credentialId,
          cloudConnectionId,
          cloudConnection: { tenantId },
          status: { in: ['PENDING', 'INVALID'] },
        },
      });
      if (candidate === null) return null;

      const updated = await tx.cloudConnectionCredential.update({
        where: { id: candidate.id },
        data: {
          status,
          validationStatus,
          validationMessage: message.slice(0, 500),
          validationAttemptedAt: attemptedAt,
        },
      });
      await tx.cloudConnection.update({
        where: { id: cloudConnectionId },
        data: { lastValidationAttemptAt: attemptedAt },
      });
      return mapCredentialSummary(updated);
    });
  }

  private requireCredentialCipher(): CredentialCipher {
    if (this.credentialCipher === undefined) {
      throw new ConfigurationError('CREDENTIAL_ENCRYPTION_KEY is required to manage cloud credentials');
    }
    return this.credentialCipher;
  }
}

function mapCredentialSummary(credential: {
  readonly id: string;
  readonly purpose: string;
  readonly status: string;
  readonly label: string;
  readonly externalPrincipalId: string | null;
  readonly keyFingerprint: string | null;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
  readonly revokedAt: Date | null;
  readonly validationStatus: string | null;
  readonly validationMessage: string | null;
  readonly validationAttemptedAt: Date | null;
}): CloudCredentialSummary {
  const validationStatus = credential.validationStatus === null
    ? undefined
    : credential.validationStatus as NonNullable<CloudCredentialSummary['validationStatus']>;
  return {
    id: credential.id,
    purpose: credential.purpose as CloudCredentialSummary['purpose'],
    status: credential.status as CloudCredentialSummary['status'],
    label: credential.label,
    ...(credential.externalPrincipalId === null ? {} : { externalPrincipalId: credential.externalPrincipalId }),
    ...(credential.keyFingerprint === null ? {} : { keyFingerprint: credential.keyFingerprint }),
    createdAt: credential.createdAt,
    ...(credential.disabledAt === null ? {} : { disabledAt: credential.disabledAt }),
    ...(credential.revokedAt === null ? {} : { revokedAt: credential.revokedAt }),
    ...(validationStatus === undefined ? {} : { validationStatus }),
    ...(credential.validationMessage === null ? {} : { validationMessage: credential.validationMessage }),
    ...(credential.validationAttemptedAt === null ? {} : { validationAttemptedAt: credential.validationAttemptedAt }),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { readonly code?: unknown }).code === 'P2002';
}

function mergeEnabledMetricDefinitions(
  metadataValue: unknown,
  definitions: readonly {
    readonly compartmentId: string;
    readonly namespace: string;
    readonly metricName: string;
    readonly externalResourceId: string;
    readonly regionId: string | null;
    readonly dimensions: unknown;
    readonly metricUnit: string | null;
    readonly statistics: unknown;
  }[],
): Record<string, unknown> | undefined {
  const metadata = isPlainObject(metadataValue) ? { ...metadataValue } : {};
  const enabled = definitions
    .filter((definition) => definition.externalResourceId.trim().length > 0)
    .map((definition) => ({
      compartmentId: definition.compartmentId,
      namespace: definition.namespace,
      metricName: definition.metricName,
      resourceId: definition.externalResourceId,
      ...(definition.regionId === null ? {} : { regionId: definition.regionId }),
      ...(isPlainObject(definition.dimensions) ? { dimensions: definition.dimensions } : {}),
      ...(definition.metricUnit === null ? {} : { unit: definition.metricUnit }),
      statistics: definition.statistics,
    }));
  if (enabled.length > 0) metadata['ociMetricDefinitions'] = enabled;
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

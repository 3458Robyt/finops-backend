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
            createdAt: true,
            disabledAt: true,
            revokedAt: true,
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

    return this.prisma.$transaction(async (tx) => {
      const connection = await tx.cloudConnection.findFirst({
        where: { id: input.cloudConnectionId, tenantId: input.tenantId },
        select: { id: true, metadata: true },
      });
      if (connection === null) return null;

      await tx.cloudConnectionCredential.updateMany({
        where: {
          cloudConnectionId: connection.id,
          purpose: input.purpose,
          status: 'ACTIVE',
        },
        data: { status: 'DISABLED', disabledAt: new Date() },
      });

      const credential = await tx.cloudConnectionCredential.create({
        data: {
          cloudConnectionId: connection.id,
          purpose: input.purpose,
          label: input.label,
          ...encrypted,
          ...(input.externalPrincipalId === undefined ? {} : { externalPrincipalId: input.externalPrincipalId }),
        },
      });

      await tx.cloudConnection.update({
        where: { id: connection.id },
        data: invalidatedValidationData(connection.metadata),
      });

      return mapCredentialSummary(credential);
    });
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
      await tx.cloudConnection.update({
        where: { id: cloudConnectionId },
        data: invalidatedValidationData(credential.cloudConnection.metadata),
      });
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
      },
    });
    if (connection === null) return null;

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
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
  readonly revokedAt: Date | null;
}): CloudCredentialSummary {
  return {
    id: credential.id,
    purpose: credential.purpose as CloudCredentialSummary['purpose'],
    status: credential.status as CloudCredentialSummary['status'],
    label: credential.label,
    ...(credential.externalPrincipalId === null ? {} : { externalPrincipalId: credential.externalPrincipalId }),
    createdAt: credential.createdAt,
    ...(credential.disabledAt === null ? {} : { disabledAt: credential.disabledAt }),
    ...(credential.revokedAt === null ? {} : { revokedAt: credential.revokedAt }),
  };
}

import { randomUUID } from 'node:crypto';
import type {
  CloudIngestionConnection,
  CloudIngestionCredential,
  CloudIngestionJobContext,
  IngestionObjectDescriptor,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { CredentialCipher, type EncryptedCredentialPayload } from '../security/CredentialCipher.js';
import { mergeEnabledMetricDefinitions } from './ingestionMetricDefinitionMetadata.js';

export interface IngestionJobPartUpdate {
  readonly status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
  readonly samplesRead?: number;
  readonly samplesWritten?: number;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly errorMessage?: string;
}

type PrismaIngestionJobWithConnection = NonNullable<Awaited<ReturnType<PrismaIngestionJobSupport['findJobContext']>>>;

/** Keeps job context hydration and durable source-part bookkeeping out of the orchestration class. */
export class PrismaIngestionJobSupport {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialCipher: CredentialCipher,
  ) {}

  public async findJobContext(
    jobId: string,
    client: Pick<PrismaClient, 'ingestionJob'> = this.prisma,
  ) {
    return client.ingestionJob.findUnique({
      where: { id: jobId },
      include: {
        cloudConnection: {
          include: {
            credentials: {
              where: { status: 'ACTIVE', purpose: { not: 'TEMPORARY_ADMIN' } },
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
        },
      },
    });
  }

  public toJobContext(job: PrismaIngestionJobWithConnection): CloudIngestionJobContext {
    return {
      id: job.id,
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      sourceType: job.sourceType,
      targetStart: job.targetStart,
      targetEnd: job.targetEnd,
      attempt: job.attempts,
      ...(job.configurationHash !== null ? { configurationHash: job.configurationHash } : {}),
      ...(this.isJsonObject(job.requestContext) ? { requestContext: job.requestContext as Record<string, unknown> } : {}),
      connection: {
        id: job.cloudConnection.id,
        tenantId: job.cloudConnection.tenantId,
        providerCode: job.cloudConnection.providerCode,
        rootExternalId: job.cloudConnection.rootExternalId,
        ...(job.cloudConnection.defaultRegion !== null ? { defaultRegion: job.cloudConnection.defaultRegion } : {}),
        ...this.metricMetadata(job),
        credentials: job.cloudConnection.credentials.flatMap((credential): CloudIngestionCredential[] => {
          if (credential.purpose === 'TEMPORARY_ADMIN') return [];
          return [{
            purpose: credential.purpose,
            payload: this.credentialCipher.decrypt({
              encryptedPayload: credential.encryptedPayload,
              encryptionIv: credential.encryptionIv,
              encryptionAuthTag: credential.encryptionAuthTag,
              encryptionAlgorithm: 'aes-256-gcm',
              encryptionKeyVersion: credential.encryptionKeyVersion,
            } satisfies EncryptedCredentialPayload),
            ...(credential.externalPrincipalId !== null ? { externalPrincipalId: credential.externalPrincipalId } : {}),
          }];
        }),
      } satisfies CloudIngestionConnection,
    };
  }

  public async updateJobPart(
    job: CloudIngestionJobContext,
    partKey: string,
    values: IngestionJobPartUpdate,
  ): Promise<void> {
    await this.prisma.ingestionJobPart.upsert({
      where: { ingestionJobId_partKey: { ingestionJobId: job.id, partKey } },
      create: {
        id: randomUUID(),
        tenantId: job.tenantId,
        cloudConnectionId: job.cloudConnectionId,
        ingestionJobId: job.id,
        partKey,
        sourceType: job.sourceType,
        status: values.status,
        targetStart: job.targetStart,
        targetEnd: job.targetEnd,
        ...partUpdateData(values),
      },
      update: { status: values.status, ...partUpdateData(values) },
    });
  }

  public async registerSourceObjects(
    job: CloudIngestionJobContext,
    objects: readonly IngestionObjectDescriptor[] | undefined,
  ): Promise<void> {
    if (objects === undefined) return;
    for (const object of objects) {
      const existing = await this.prisma.ingestionObject.findFirst({
        where: {
          cloudConnectionId: job.cloudConnectionId,
          objectUri: object.objectUri,
          ...(object.objectEtag === undefined ? { objectEtag: null } : { objectEtag: object.objectEtag }),
        },
        select: { id: true },
      });
      if (existing === null) {
        await this.prisma.ingestionObject.create({
          data: {
            id: randomUUID(),
            tenantId: job.tenantId,
            cloudConnectionId: job.cloudConnectionId,
            ingestionJobId: job.id,
            sourceType: job.sourceType,
            objectUri: object.objectUri,
            ...(object.objectEtag === undefined ? {} : { objectEtag: object.objectEtag }),
            ...(object.objectVersion === undefined ? {} : { objectVersion: object.objectVersion }),
            status: 'PENDING',
          },
        });
      } else {
        await this.prisma.ingestionObject.update({
          where: { id: existing.id },
          data: { ingestionJobId: job.id, status: 'PENDING', errorMessage: null, processedAt: null },
        });
      }
    }
  }

  public completeSourceObjects(
    job: CloudIngestionJobContext,
    objects: readonly IngestionObjectDescriptor[] | undefined,
    rowsProcessed: number,
  ): Promise<{ count: number }> {
    if (objects === undefined || objects.length === 0) return Promise.resolve({ count: 0 });
    return this.prisma.ingestionObject.updateMany({
      where: { ingestionJobId: job.id, status: 'PENDING' },
      data: { status: 'SUCCESS', rowsProcessed, processedAt: new Date(), errorMessage: null },
    });
  }

  private metricMetadata(job: PrismaIngestionJobWithConnection): Record<string, unknown> {
    const metadata = mergeEnabledMetricDefinitions(job.cloudConnection.metadata, job.cloudConnection.metricDefinitions);
    return metadata === undefined ? {} : { metadata };
  }

  private isJsonObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}

function partUpdateData(values: IngestionJobPartUpdate): Record<string, unknown> {
  return {
    ...(values.rowsRead === undefined ? {} : { rowsRead: values.rowsRead }),
    ...(values.rowsWritten === undefined ? {} : { rowsWritten: values.rowsWritten }),
    ...(values.samplesRead === undefined ? {} : { samplesRead: values.samplesRead }),
    ...(values.samplesWritten === undefined ? {} : { samplesWritten: values.samplesWritten }),
    ...(values.startedAt === undefined ? {} : { startedAt: values.startedAt }),
    ...(values.completedAt === undefined ? {} : { completedAt: values.completedAt }),
    ...(values.errorMessage === undefined ? {} : { errorMessage: values.errorMessage }),
  };
}

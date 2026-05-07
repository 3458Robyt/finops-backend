import type {
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  ICloudConnectionRepository,
  IngestionJobSummary,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudConnectionSummary,
  DataQualityStatus,
  IngestionHealthSummary,
  IngestionSourceType,
  ProviderCatalogEntry,
} from '../../domain/models/CloudConnection.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

type PrismaProviderCatalog = Awaited<
  ReturnType<PrismaClient['providerCatalog']['findUnique']>
>;

type PrismaCloudConnection = Awaited<
  ReturnType<PrismaClient['cloudConnection']['findUnique']>
>;

export class PrismaCloudConnectionRepository implements ICloudConnectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async listProviderCatalog(): Promise<readonly ProviderCatalogEntry[]> {
    const providers = await this.prisma.providerCatalog.findMany({
      where: { enabled: true },
      orderBy: { code: 'asc' },
    });

    return providers.map((provider) => this.mapProvider(provider));
  }

  public async findProviderCatalog(providerCode: string): Promise<ProviderCatalogEntry | null> {
    const provider = await this.prisma.providerCatalog.findUnique({
      where: { code: providerCode },
    });

    return provider === null ? null : this.mapProvider(provider);
  }

  public async createCloudConnection(
    input: CreateCloudConnectionInput,
  ): Promise<CloudConnectionSummary> {
    const connection = await this.prisma.cloudConnection.create({
      data: {
        tenantId: input.tenantId,
        providerCode: input.providerCode,
        rootExternalId: input.rootExternalId,
        name: input.name,
        ...(input.defaultRegion !== undefined ? { defaultRegion: input.defaultRegion } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    return this.mapCloudConnection(connection);
  }

  public async findCloudConnectionForTenant(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudConnectionSummary | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: {
        id: cloudConnectionId,
        tenantId,
      },
    });

    return connection === null ? null : this.mapCloudConnection(connection);
  }

  public async listCloudConnectionsForTenant(
    tenantId: string,
  ): Promise<readonly CloudConnectionSummary[]> {
    const connections = await this.prisma.cloudConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    return connections.map((connection) => this.mapCloudConnection(connection));
  }

  public async markCloudConnectionValidated(
    cloudConnectionId: string,
    validatedAt: Date,
  ): Promise<void> {
    await this.prisma.cloudConnection.update({
      where: { id: cloudConnectionId },
      data: { lastValidatedAt: validatedAt },
    });
  }

  public async createIngestionJob(input: CreateIngestionJobInput): Promise<IngestionJobSummary> {
    const job = await this.prisma.ingestionJob.create({
      data: {
        tenantId: input.tenantId,
        cloudConnectionId: input.cloudConnectionId,
        sourceType: input.sourceType,
        targetStart: input.targetStart,
        targetEnd: input.targetEnd,
        ...(input.requestedByUserId !== undefined
          ? { requestedByUserId: input.requestedByUserId }
          : {}),
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      },
    });

    return {
      id: job.id,
      tenantId: job.tenantId,
      cloudConnectionId: job.cloudConnectionId,
      sourceType: job.sourceType,
      status: job.status,
      targetStart: job.targetStart,
      targetEnd: job.targetEnd,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  public async getIngestionHealth(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<IngestionHealthSummary | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: { id: cloudConnectionId, tenantId },
      include: {
        providerCatalog: true,
        ingestionWatermarks: true,
        dataQualityChecks: {
          orderBy: { observedAt: 'desc' },
          take: 20,
        },
      },
    });

    if (connection === null) {
      return null;
    }

    const [pending, running, failed] = await Promise.all([
      this.countJobs(tenantId, cloudConnectionId, 'PENDING'),
      this.countJobs(tenantId, cloudConnectionId, 'RUNNING'),
      this.countJobs(tenantId, cloudConnectionId, 'FAILED'),
    ]);

    return {
      cloudConnection: this.mapCloudConnection(connection),
      provider: this.mapProvider(connection.providerCatalog),
      jobs: { pending, running, failed },
      watermarks: connection.ingestionWatermarks.map((watermark) => ({
        sourceType: watermark.sourceType as IngestionSourceType,
        ...(watermark.watermarkStart !== null ? { watermarkStart: watermark.watermarkStart } : {}),
        ...(watermark.watermarkEnd !== null ? { watermarkEnd: watermark.watermarkEnd } : {}),
        ...(watermark.lastSuccessfulRunAt !== null
          ? { lastSuccessfulRunAt: watermark.lastSuccessfulRunAt }
          : {}),
        ...(watermark.freshnessDeadlineAt !== null
          ? { freshnessDeadlineAt: watermark.freshnessDeadlineAt }
          : {}),
      })),
      qualityChecks: connection.dataQualityChecks.map((check) => ({
        sourceType: check.sourceType as IngestionSourceType,
        checkName: check.checkName,
        status: check.status as DataQualityStatus,
        observedAt: check.observedAt,
        ...(check.expectedAt !== null ? { expectedAt: check.expectedAt } : {}),
        ...(this.isJsonObject(check.details)
          ? { details: check.details as Record<string, unknown> }
          : {}),
      })),
    };
  }

  private async countJobs(
    tenantId: string,
    cloudConnectionId: string,
    status: 'PENDING' | 'RUNNING' | 'FAILED',
  ): Promise<number> {
    return this.prisma.ingestionJob.count({
      where: { tenantId, cloudConnectionId, status },
    });
  }

  private mapProvider(provider: NonNullable<PrismaProviderCatalog>): ProviderCatalogEntry {
    return {
      code: provider.code,
      displayName: provider.displayName,
      provider: provider.provider,
      capabilities: provider.capabilities,
      ...(provider.defaultFocusVersion !== null
        ? { defaultFocusVersion: provider.defaultFocusVersion }
        : {}),
      ...(provider.documentationUrl !== null ? { documentationUrl: provider.documentationUrl } : {}),
      enabled: provider.enabled,
    };
  }

  private mapCloudConnection(connection: NonNullable<PrismaCloudConnection>): CloudConnectionSummary {
    return {
      id: connection.id,
      tenantId: connection.tenantId,
      providerCode: connection.providerCode,
      rootExternalId: connection.rootExternalId,
      name: connection.name,
      status: connection.status,
      ...(connection.defaultRegion !== null ? { defaultRegion: connection.defaultRegion } : {}),
      ...(this.isJsonObject(connection.metadata)
        ? { metadata: connection.metadata as Record<string, unknown> }
        : {}),
      ...(connection.lastValidatedAt !== null ? { lastValidatedAt: connection.lastValidatedAt } : {}),
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    };
  }

  private isJsonObject(value: Prisma.JsonValue | null): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
}

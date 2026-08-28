import type {
  ConfigureBillingSourceForConnectionInput,
  ConfigureBillingSourceForConnectionResult,
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionInput,
  ConfigureMetricDefinitionsForConnectionResult,
  CloudCredentialSummary,
  CloudMetricDefinitionSummary,
  CreateCloudAuditEventInput,
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionJobRangeQuery,
  IngestionJobWindowItem,
  IngestionReadinessSummary,
  IngestionJobHistoryItem,
  IngestionMetricCoverageQuery,
  IngestionMetricCoverageResult,
  IngestionJobSummary,
  StoreCloudCredentialInput,
  UpdateCloudConnectionInput,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type { CloudIngestionConnection } from '../../domain/interfaces/ICloudIngestionProvider.js';
import type {
  CloudConnectionSummary,
  IngestionHealthSummary,
  IngestionSourceType,
  ProviderCatalogEntry,
} from '../../domain/models/CloudConnection.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  isJsonObject,
  mapCloudConnection,
  mapProvider,
} from './mappers/cloudConnectionMappers.js';
import { PrismaCloudCredentialRepository } from './PrismaCloudCredentialRepository.js';
import { PrismaCloudConnectionConfigurationRepository } from './PrismaCloudConnectionConfigurationRepository.js';
import { invalidatedValidationData } from './cloudConnectionMetadata.js';
import { isValidationAuthenticated } from './cloudConnectionValidation.js';
import { CredentialCipher } from '../security/CredentialCipher.js';
import { PrismaCloudIngestionReadRepository } from './PrismaCloudIngestionReadRepository.js';
import { PrismaCloudIngestionCommandRepository } from './PrismaCloudIngestionCommandRepository.js';

/** Prisma adapter for cloud connections, credentials, ingestion and audit operations. */
export class PrismaCloudConnectionRepository implements ICloudConnectionRepository {
  private readonly credentialRepository: PrismaCloudCredentialRepository;
  private readonly configurationRepository: PrismaCloudConnectionConfigurationRepository;
  private readonly ingestionReadRepository: PrismaCloudIngestionReadRepository;
  private readonly ingestionCommandRepository: PrismaCloudIngestionCommandRepository;

  constructor(
    private readonly prisma: PrismaClient,
    credentialCipher?: CredentialCipher,
  ) {
    this.credentialRepository = new PrismaCloudCredentialRepository(prisma, credentialCipher);
    this.configurationRepository = new PrismaCloudConnectionConfigurationRepository(prisma);
    this.ingestionReadRepository = new PrismaCloudIngestionReadRepository(prisma);
    this.ingestionCommandRepository = new PrismaCloudIngestionCommandRepository(prisma);
  }

  /** Lists enabled providers ordered by code. */
  public async listProviderCatalog(): Promise<readonly ProviderCatalogEntry[]> {
    const providers = await this.prisma.providerCatalog.findMany({
      where: { enabled: true },
      orderBy: { code: 'asc' },
    });

    return providers.map((provider) => mapProvider(provider));
  }

  /** Finds a provider catalog entry by code. */
  public async findProviderCatalog(providerCode: string): Promise<ProviderCatalogEntry | null> {
    const provider = await this.prisma.providerCatalog.findUnique({
      where: { code: providerCode },
    });

    return provider === null ? null : mapProvider(provider);
  }

  /** Creates a connection without arbitrary secret-bearing metadata. */
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
      },
    });

    return mapCloudConnection(connection);
  }

  public async updateCloudConnection(
    input: UpdateCloudConnectionInput,
  ): Promise<CloudConnectionSummary | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: { id: input.cloudConnectionId, tenantId: input.tenantId },
      select: { id: true, defaultRegion: true, metadata: true },
    });
    if (connection === null) return null;

    const nextRegion = input.defaultRegion ?? null;
    const regionChanged = connection.defaultRegion !== nextRegion;
    const updated = await this.prisma.cloudConnection.update({
      where: { id: connection.id },
      data: {
        name: input.name,
        defaultRegion: nextRegion,
        ...(regionChanged ? invalidatedValidationData(connection.metadata) : {}),
      },
    });
    return mapCloudConnection(updated);
  }

  /** Finds a connection with an explicit tenant filter. */
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

    return connection === null ? null : mapCloudConnection(connection);
  }

  /** Lists a tenant's connections from newest to oldest. */
  public async listCloudConnectionsForTenant(
    tenantId: string,
  ): Promise<readonly CloudConnectionSummary[]> {
    const connections = await this.prisma.cloudConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    return connections.map((connection) => mapCloudConnection(connection));
  }

  public async setCloudConnectionStatus(
    tenantId: string,
    cloudConnectionId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<CloudConnectionSummary | null> {
    const result = await this.prisma.cloudConnection.updateMany({
      where: { id: cloudConnectionId, tenantId },
      data: { status },
    });
    if (result.count === 0) return null;
    const connection = await this.prisma.cloudConnection.findUnique({ where: { id: cloudConnectionId } });
    return connection === null ? null : mapCloudConnection(connection);
  }

  public listCredentialSummaries(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<readonly CloudCredentialSummary[] | null> {
    return this.credentialRepository.listCredentialSummaries(tenantId, cloudConnectionId);
  }

  public storeCredential(input: StoreCloudCredentialInput): Promise<CloudCredentialSummary | null> {
    return this.credentialRepository.storeCredential(input);
  }

  public revokeCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
  ): Promise<CloudCredentialSummary | null> {
    return this.credentialRepository.revokeCredential(tenantId, cloudConnectionId, credentialId);
  }

  public getIngestionConnectionForTenant(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudIngestionConnection | null> {
    return this.credentialRepository.getIngestionConnectionForTenant(tenantId, cloudConnectionId);
  }

  public async listEnabledMetricDefinitions(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<readonly CloudMetricDefinitionSummary[]> {
    const definitions = await this.prisma.cloudMetricDefinition.findMany({
      where: {
        tenantId,
        cloudConnectionId,
        enabled: true,
      },
      orderBy: [{ regionId: 'asc' }, { namespace: 'asc' }, { metricName: 'asc' }],
      select: {
        id: true,
        compartmentId: true,
        namespace: true,
        metricName: true,
        externalResourceId: true,
        regionId: true,
        dimensions: true,
        metricUnit: true,
        statistics: true,
      },
    });
    return definitions.map((definition) => ({
      id: definition.id,
      compartmentId: definition.compartmentId,
      namespace: definition.namespace,
      metricName: definition.metricName,
      externalResourceId: definition.externalResourceId,
      ...(definition.regionId === null ? {} : { regionId: definition.regionId }),
      ...(isJsonObject(definition.dimensions) ? { dimensions: definition.dimensions as Record<string, unknown> } : {}),
      ...(definition.metricUnit === null ? {} : { metricUnit: definition.metricUnit }),
      statistics: definition.statistics,
    }));
  }

  public getIngestionConnectionForCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
  ): Promise<CloudIngestionConnection | null> {
    return this.credentialRepository.getIngestionConnectionForCredential(
      tenantId,
      cloudConnectionId,
      credentialId,
    );
  }

  public promoteCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
  ): Promise<CloudCredentialSummary | null> {
    return this.credentialRepository.promoteCredential(tenantId, cloudConnectionId, credentialId);
  }

  public updateCredentialValidation(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
    status: 'PENDING' | 'INVALID',
    validationStatus: 'VERIFIED' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NOT_CONFIGURED',
    message: string,
    attemptedAt: Date,
  ): Promise<CloudCredentialSummary | null> {
    return this.credentialRepository.updateCredentialValidation(
      tenantId,
      cloudConnectionId,
      credentialId,
      status,
      validationStatus,
      message,
      attemptedAt,
    );
  }

  public async saveConnectionValidation(
    tenantId: string,
    cloudConnectionId: string,
    validation: Readonly<Record<string, unknown>>,
    validatedAt: Date,
  ): Promise<CloudConnectionSummary | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: { id: cloudConnectionId, tenantId },
      select: { id: true, metadata: true },
    });
    if (connection === null) return null;

    const metadata = {
      ...(isJsonObject(connection.metadata) ? connection.metadata as Record<string, unknown> : {}),
      capabilityValidation: validation,
    };
    const updated = await this.prisma.cloudConnection.update({
      where: { id: connection.id },
      data: {
        metadata: metadata as Prisma.InputJsonValue,
        lastValidationAttemptAt: validatedAt,
        ...(isValidationAuthenticated(validation) ? { lastValidatedAt: validatedAt } : {}),
      },
    });

    return mapCloudConnection(updated);
  }

  public async createCloudAuditEvent(input: CreateCloudAuditEventInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  /**
   * Marca una conexión cloud como validada en una fecha dada (actualiza
   * `lastValidatedAt`).
   *
   * @param cloudConnectionId Identificador de la conexión a marcar.
   * @param validatedAt Marca temporal de la validación exitosa.
   * @returns Promesa que se resuelve cuando la actualización finaliza.
   */
  public async markCloudConnectionValidated(
    cloudConnectionId: string,
    validatedAt: Date,
  ): Promise<void> {
    await this.prisma.cloudConnection.update({
      where: { id: cloudConnectionId },
      data: { lastValidatedAt: validatedAt },
    });
  }

  public createIngestionJob(input: CreateIngestionJobInput): Promise<IngestionJobSummary> {
    return this.ingestionCommandRepository.createIngestionJob(input);
  }

  public getIngestionHealth(tenantId: string, cloudConnectionId: string): Promise<IngestionHealthSummary | null> {
    return this.ingestionReadRepository.getIngestionHealth(tenantId, cloudConnectionId);
  }

  public listIngestionJobsForTenant(tenantId: string, limit: number, includeArchived = false): Promise<readonly IngestionJobHistoryItem[]> {
    return this.ingestionReadRepository.listIngestionJobsForTenant(tenantId, limit, includeArchived);
  }

  public getIngestionJobForTenant(tenantId: string, jobId: string): Promise<IngestionJobHistoryItem | null> {
    return this.ingestionReadRepository.getIngestionJobForTenant(tenantId, jobId);
  }

  public requestIngestionJobCancellation(tenantId: string, jobId: string, userId: string): Promise<IngestionJobHistoryItem | null> {
    return this.ingestionReadRepository.requestIngestionJobCancellation(tenantId, jobId, userId);
  }

  public archiveIngestionJob(tenantId: string, jobId: string, userId: string): Promise<IngestionJobHistoryItem | null> {
    return this.ingestionReadRepository.archiveIngestionJob(tenantId, jobId, userId);
  }

  public listDataQualityChecksForTenant(tenantId: string, limit: number): Promise<readonly DataQualityCheckItem[]> {
    return this.ingestionReadRepository.listDataQualityChecksForTenant(tenantId, limit);
  }

  public listIngestionJobsForConnectionRange(input: IngestionJobRangeQuery): Promise<readonly IngestionJobWindowItem[]> {
    return this.ingestionReadRepository.listIngestionJobsForConnectionRange(input);
  }

  public listFailedIngestionJobsForConnection(tenantId: string, cloudConnectionId: string, sourceType?: IngestionSourceType): Promise<readonly IngestionJobWindowItem[]> {
    return this.ingestionReadRepository.listFailedIngestionJobsForConnection(tenantId, cloudConnectionId, sourceType);
  }

  public cancelPendingIngestionJobs(tenantId: string, cloudConnectionId: string, sourceType: IngestionSourceType): Promise<number> {
    return this.ingestionReadRepository.cancelPendingIngestionJobs(tenantId, cloudConnectionId, sourceType);
  }

  public listIngestionReadinessForTenant(tenantId: string): Promise<IngestionReadinessSummary> {
    return this.ingestionReadRepository.listIngestionReadinessForTenant(tenantId);
  }

  public listMetricCoverageForTenant(
    input: IngestionMetricCoverageQuery,
  ): Promise<IngestionMetricCoverageResult> {
    return this.ingestionReadRepository.listMetricCoverageForTenant(input);
  }

  public async configureFocusSourceForConnection(
    input: ConfigureFocusSourceForConnectionInput,
  ): Promise<ConfigureFocusSourceForConnectionResult | null> {
    return this.configurationRepository.configureFocusSourceForConnection(input);
  }

  public async configureBillingSourceForConnection(
    input: ConfigureBillingSourceForConnectionInput,
  ): Promise<ConfigureBillingSourceForConnectionResult | null> {
    return this.configurationRepository.configureBillingSourceForConnection(input);
  }

  public async configureMetricDefinitionsForConnection(
    input: ConfigureMetricDefinitionsForConnectionInput,
  ): Promise<ConfigureMetricDefinitionsForConnectionResult | null> {
    return this.configurationRepository.configureMetricDefinitionsForConnection(input);
  }
}

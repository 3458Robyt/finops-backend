import type {
  ConfigureBillingSourceForConnectionInput,
  ConfigureBillingSourceForConnectionResult,
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionInput,
  ConfigureMetricDefinitionsForConnectionResult,
  CloudCredentialSummary,
  CreateCloudAuditEventInput,
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionJobRangeQuery,
  IngestionJobWindowItem,
  IngestionReadinessSummary,
  IngestionJobHistoryItem,
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
import { CredentialCipher } from '../security/CredentialCipher.js';
import { PrismaCloudIngestionReadRepository } from './PrismaCloudIngestionReadRepository.js';
import { PrismaCloudIngestionCommandRepository } from './PrismaCloudIngestionCommandRepository.js';

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link ICloudConnectionRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: gestionar el catálogo de proveedores cloud
 * (`provider_catalog`), las conexiones cloud de cada tenant
 * (`cloud_connections`), los trabajos de ingesta (`ingestion_jobs`) y la salud
 * de ingesta (watermarks y controles de calidad de datos). Las operaciones sobre
 * conexiones filtran por `tenantId` para garantizar el aislamiento multi-tenant.
 */
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

  /**
   * Lista el catálogo de proveedores cloud habilitados, ordenados por código.
   *
   * @returns Lista de solo lectura de entradas del catálogo de proveedores;
   *   arreglo vacío si no hay proveedores habilitados.
   */
  public async listProviderCatalog(): Promise<readonly ProviderCatalogEntry[]> {
    const providers = await this.prisma.providerCatalog.findMany({
      where: { enabled: true },
      orderBy: { code: 'asc' },
    });

    return providers.map((provider) => mapProvider(provider));
  }

  /**
   * Busca una entrada del catálogo de proveedores por su código único.
   *
   * @param providerCode Código del proveedor (clave única en `provider_catalog`).
   * @returns La entrada del catálogo de dominio, o `null` si no existe.
   */
  public async findProviderCatalog(providerCode: string): Promise<ProviderCatalogEntry | null> {
    const provider = await this.prisma.providerCatalog.findUnique({
      where: { code: providerCode },
    });

    return provider === null ? null : mapProvider(provider);
  }

  /**
   * Crea una nueva conexión cloud para un tenant.
   *
   * La metadata operativa se configura después mediante operaciones tipadas;
   * el alta no acepta un objeto arbitrario que pudiera contener secretos.
   *
   * @param input Datos de la conexión (tenant, proveedor, identificador raíz,
   *   nombre y región opcional).
   * @returns Resumen de la conexión creada en formato de dominio.
   */
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

  /**
   * Busca una conexión cloud por su id, restringida al tenant indicado.
   *
   * El filtro combinado `id` + `tenantId` garantiza el aislamiento multi-tenant
   * (un tenant no puede acceder a conexiones de otro).
   *
   * @param tenantId Tenant propietario de la conexión.
   * @param cloudConnectionId Identificador de la conexión.
   * @returns Resumen de la conexión de dominio, o `null` si no existe o no
   *   pertenece al tenant.
   */
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

  /**
   * Lista todas las conexiones cloud de un tenant, de la más reciente a la más
   * antigua.
   *
   * @param tenantId Tenant cuyas conexiones se listan (aislamiento multi-tenant).
   * @returns Lista de solo lectura de resúmenes de conexión; arreglo vacío si no
   *   hay conexiones.
   */
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
        lastValidatedAt: validatedAt,
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

  public listIngestionJobsForTenant(tenantId: string, limit: number): Promise<readonly IngestionJobHistoryItem[]> {
    return this.ingestionReadRepository.listIngestionJobsForTenant(tenantId, limit);
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

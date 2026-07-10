import type {
  CreateCloudConnectionInput,
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  CreateIngestionJobInput,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionJobRangeQuery,
  IngestionJobWindowItem,
  IngestionReadinessSummary,
  IngestionJobHistoryItem,
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
import {
  isJsonObject,
  mapCloudConnection,
  mapProvider,
  toDataQualityCheckItem,
  toIngestionJobHistoryItem,
} from './mappers/cloudConnectionMappers.js';
import { buildIngestionReadinessSummary } from '../ingestion/ingestionReadiness.js';
import { configureFocusSourceMetadata } from '../ingestion/focusSourceMetadata.js';

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
  constructor(private readonly prisma: PrismaClient) {}

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
   * Los campos opcionales (`defaultRegion`, `metadata`) solo se incluyen cuando
   * están definidos; `metadata` se serializa como JSON de Prisma.
   *
   * @param input Datos de la conexión (tenant, proveedor, identificador raíz,
   *   nombre y metadatos opcionales).
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
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    return mapCloudConnection(connection);
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

  /**
   * Crea un trabajo de ingesta (`ingestion_jobs`) para una conexión cloud,
   * acotado a un rango temporal objetivo.
   *
   * Los campos opcionales (`requestedByUserId`, `maxAttempts`) solo se incluyen
   * cuando están definidos. La proyección de salida se construye en línea (no usa
   * un mapper compartido).
   *
   * @param input Datos del trabajo (tenant, conexión, tipo de fuente, rango
   *   objetivo y opciones).
   * @returns Resumen del trabajo de ingesta creado.
   */
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

  /**
   * Obtiene un resumen de salud de ingesta para una conexión cloud de un tenant.
   *
   * Carga la conexión junto con su proveedor, los watermarks de ingesta y los
   * últimos 20 controles de calidad de datos. Además, cuenta en paralelo los
   * trabajos en estado `PENDING`, `RUNNING` y `FAILED`. Los campos anulables de
   * watermarks/checks solo se incluyen cuando no son `null`, y los `details`
   * solo cuando son un objeto JSON (ver {@link isJsonObject}).
   *
   * @param tenantId Tenant propietario de la conexión (aislamiento multi-tenant).
   * @param cloudConnectionId Identificador de la conexión.
   * @returns Resumen de salud de ingesta de dominio, o `null` si la conexión no
   *   existe o no pertenece al tenant.
   */
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
      cloudConnection: mapCloudConnection(connection),
      provider: mapProvider(connection.providerCatalog),
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
        ...(isJsonObject(check.details)
          ? { details: check.details as Record<string, unknown> }
          : {}),
      })),
    };
  }

  /**
   * Cuenta los trabajos de ingesta de una conexión que se encuentran en un
   * estado concreto, dentro de un tenant.
   *
   * @param tenantId Tenant propietario (aislamiento multi-tenant).
   * @param cloudConnectionId Conexión cuyos trabajos se cuentan.
   * @param status Estado del trabajo a contabilizar.
   * @returns Número de trabajos en ese estado.
   */
  private async countJobs(
    tenantId: string,
    cloudConnectionId: string,
    status: 'PENDING' | 'RUNNING' | 'FAILED',
  ): Promise<number> {
    return this.prisma.ingestionJob.count({
      where: { tenantId, cloudConnectionId, status },
    });
  }

  /**
   * Lista el historial de trabajos de ingesta de un tenant (todas sus
   * conexiones), del más reciente al más antiguo, acotado a `limit`.
   *
   * Filtra por `tenantId` (aislamiento multi-tenant) y ordena por `createdAt`
   * descendente. Mapea cada fila con {@link toIngestionJobHistoryItem}.
   *
   * @param tenantId Tenant cuyo historial se consulta.
   * @param limit Número máximo de trabajos a devolver.
   * @returns Historial de trabajos de ingesta; arreglo vacío si no hay.
   */
  public async listIngestionJobsForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly IngestionJobHistoryItem[]> {
    const jobs = await this.prisma.ingestionJob.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return jobs.map((job) => toIngestionJobHistoryItem(job));
  }

  /**
   * Lista los controles de calidad de datos de un tenant, del más reciente al
   * más antiguo, acotado a `limit`.
   *
   * Filtra por `tenantId` (aislamiento multi-tenant) y ordena por `observedAt`
   * descendente. Mapea cada fila con {@link toDataQualityCheckItem}.
   *
   * @param tenantId Tenant cuyos controles se consultan.
   * @param limit Número máximo de controles a devolver.
   * @returns Controles de calidad de datos; arreglo vacío si no hay.
   */
  public async listDataQualityChecksForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly DataQualityCheckItem[]> {
    const checks = await this.prisma.dataQualityCheck.findMany({
      where: { tenantId },
      orderBy: { observedAt: 'desc' },
      take: limit,
    });

    return checks.map((check) => toDataQualityCheckItem(check));
  }

  public async listIngestionJobsForConnectionRange(
    input: IngestionJobRangeQuery,
  ): Promise<readonly IngestionJobWindowItem[]> {
    const jobs = await this.prisma.ingestionJob.findMany({
      where: {
        tenantId: input.tenantId,
        cloudConnectionId: input.cloudConnectionId,
        sourceType: input.sourceType,
        status: { in: ['PENDING', 'RUNNING', 'SUCCESS'] },
        targetStart: { lt: input.targetEnd },
        targetEnd: { gt: input.targetStart },
      },
      orderBy: { targetStart: 'asc' },
      select: {
        id: true,
        sourceType: true,
        status: true,
        targetStart: true,
        targetEnd: true,
      },
    });

    return jobs.map((job) => ({
      id: job.id,
      sourceType: job.sourceType,
      status: job.status,
      targetStart: job.targetStart,
      targetEnd: job.targetEnd,
    }));
  }

  public async listIngestionReadinessForTenant(tenantId: string): Promise<IngestionReadinessSummary> {
    const connections = await this.prisma.cloudConnection.findMany({
      where: {
        tenantId,
        providerCode: { in: ['aws', 'oci'] },
        status: 'ACTIVE',
      },
      orderBy: [{ providerCode: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        providerCode: true,
        defaultRegion: true,
        metadata: true,
        credentials: {
          where: { status: 'ACTIVE' },
          select: { purpose: true },
        },
        ingestionJobs: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            sourceType: true,
            status: true,
            targetStart: true,
            targetEnd: true,
            errorMessage: true,
            resultSummary: true,
            completedAt: true,
          },
        },
      },
    });

    return buildIngestionReadinessSummary({
      generatedAt: new Date(),
      missingProviderMessageSuffix: ' for this tenant',
      connections: connections.map((connection) => ({
        id: connection.id,
        name: connection.name,
        providerCode: connection.providerCode,
        defaultRegion: connection.defaultRegion,
        metadata: connection.metadata,
        credentialPurposes: connection.credentials.map((credential) => credential.purpose),
        recentJobs: connection.ingestionJobs.map((job) => ({
          id: job.id,
          sourceType: job.sourceType,
          status: job.status,
          targetStart: job.targetStart,
          targetEnd: job.targetEnd,
          completedAt: job.completedAt,
          errorMessage: job.errorMessage,
          resultSummary: job.resultSummary,
        })),
      })),
    });
  }

  public async configureFocusSourceForConnection(
    input: ConfigureFocusSourceForConnectionInput,
  ): Promise<ConfigureFocusSourceForConnectionResult | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: {
        id: input.cloudConnectionId,
        tenantId: input.tenantId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        providerCode: true,
        metadata: true,
      },
    });

    if (connection === null) {
      return null;
    }

    const result = configureFocusSourceMetadata({
      provider: connection.providerCode,
      mode: input.mode,
      values: new Map(Object.entries(input.values)),
      existingMetadata: isJsonObject(connection.metadata) ? connection.metadata as Record<string, unknown> : {},
      replace: input.replace,
    });

    await this.prisma.cloudConnection.update({
      where: { id: connection.id },
      data: { metadata: result.metadata as Prisma.InputJsonValue },
    });

    return {
      cloudConnectionId: connection.id,
      providerCode: connection.providerCode,
      mode: input.mode,
      updatedKey: result.updatedKey,
      configuredCount: result.configuredCount,
      replaced: input.replace,
    };
  }
}

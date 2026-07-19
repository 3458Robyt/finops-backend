import type {
  ConfigureBillingSourceForConnectionInput,
  ConfigureBillingSourceForConnectionResult,
  CloudCredentialSummary,
  CreateCloudAuditEventInput,
  CreateCloudConnectionInput,
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionInput,
  ConfigureMetricDefinitionsForConnectionResult,
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
import { CredentialCipher } from '../security/CredentialCipher.js';
import { ConfigurationError } from '../../domain/errors/errors.js';

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
  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentialCipher?: CredentialCipher,
  ) {}

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
    const updated = await this.prisma.cloudConnection.updateMany({
      where: { id: input.cloudConnectionId, tenantId: input.tenantId },
      data: {
        name: input.name,
        defaultRegion: input.defaultRegion ?? null,
      },
    });
    if (updated.count === 0) return null;
    const connection = await this.prisma.cloudConnection.findUnique({ where: { id: input.cloudConnectionId } });
    return connection === null ? null : mapCloudConnection(connection);
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
        select: { id: true },
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
          ...(input.externalPrincipalId !== undefined
            ? { externalPrincipalId: input.externalPrincipalId }
            : {}),
        },
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
    });
    if (credential === null) return null;

    return mapCredentialSummary(await this.prisma.cloudConnectionCredential.update({
      where: { id: credential.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    }));
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
      ...(connection.defaultRegion !== null ? { defaultRegion: connection.defaultRegion } : {}),
      ...(isJsonObject(connection.metadata)
        ? { metadata: connection.metadata as Record<string, unknown> }
        : {}),
      credentials: connection.credentials.map((credential) => ({
        purpose: credential.purpose as CloudIngestionConnection['credentials'][number]['purpose'],
        payload: this.requireCredentialCipher().decrypt({
          encryptedPayload: credential.encryptedPayload,
          encryptionIv: credential.encryptionIv,
          encryptionAuthTag: credential.encryptionAuthTag,
          encryptionAlgorithm: 'aes-256-gcm',
          encryptionKeyVersion: credential.encryptionKeyVersion,
        }),
        ...(credential.externalPrincipalId !== null
          ? { externalPrincipalId: credential.externalPrincipalId }
          : {}),
      })),
    };
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

  private requireCredentialCipher(): CredentialCipher {
    if (this.credentialCipher === undefined) {
      throw new ConfigurationError('CREDENTIAL_ENCRYPTION_KEY is required to manage cloud credentials');
    }

    return this.credentialCipher;
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
    try {
      return toIngestionJobSummary(await this.prisma.ingestionJob.create({
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
      }));
    } catch (error: unknown) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const existing = await this.prisma.ingestionJob.findFirst({
        where: {
          tenantId: input.tenantId,
          cloudConnectionId: input.cloudConnectionId,
          sourceType: input.sourceType,
          targetStart: input.targetStart,
          targetEnd: input.targetEnd,
          status: { in: ['PENDING', 'RUNNING'] },
        },
      });
      if (existing === null) throw error;
      return toIngestionJobSummary(existing);
    }
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

  public async listFailedIngestionJobsForConnection(
    tenantId: string,
    cloudConnectionId: string,
    sourceType?: IngestionSourceType,
  ): Promise<readonly IngestionJobWindowItem[]> {
    const jobs = await this.prisma.ingestionJob.findMany({
      where: {
        tenantId,
        cloudConnectionId,
        status: 'FAILED',
        ...(sourceType !== undefined ? { sourceType } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, sourceType: true, status: true, targetStart: true, targetEnd: true },
    });
    return jobs.map((job) => ({
      id: job.id,
      sourceType: job.sourceType,
      status: job.status,
      targetStart: job.targetStart,
      targetEnd: job.targetEnd,
    }));
  }

  public async cancelPendingIngestionJobs(
    tenantId: string,
    cloudConnectionId: string,
    sourceType: IngestionSourceType,
  ): Promise<number> {
    const result = await this.prisma.ingestionJob.updateMany({
      where: { tenantId, cloudConnectionId, sourceType, status: 'PENDING' },
      data: { status: 'CANCELLED', completedAt: new Date(), errorMessage: 'Cancelado por el usuario.' },
    });
    return result.count;
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
        lastValidatedAt: true,
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
        lastValidatedAt: connection.lastValidatedAt,
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

  public async configureBillingSourceForConnection(
    input: ConfigureBillingSourceForConnectionInput,
  ): Promise<ConfigureBillingSourceForConnectionResult | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: {
        id: input.cloudConnectionId,
        tenantId: input.tenantId,
        status: 'ACTIVE',
      },
      select: { id: true, providerCode: true, metadata: true },
    });

    if (connection === null) return null;

    const metadata = isJsonObject(connection.metadata)
      ? { ...(connection.metadata as Record<string, unknown>), billingSourceMode: input.mode }
      : { billingSourceMode: input.mode };

    await this.prisma.cloudConnection.update({
      where: { id: connection.id },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });

    return {
      cloudConnectionId: connection.id,
      providerCode: connection.providerCode,
      mode: input.mode,
    };
  }

  public async configureMetricDefinitionsForConnection(
    input: ConfigureMetricDefinitionsForConnectionInput,
  ): Promise<ConfigureMetricDefinitionsForConnectionResult | null> {
    const connection = await this.prisma.cloudConnection.findFirst({
      where: { id: input.cloudConnectionId, tenantId: input.tenantId, status: 'ACTIVE' },
      select: { id: true, providerCode: true, metadata: true },
    });
    if (connection === null || (connection.providerCode !== 'aws' && connection.providerCode !== 'oci')) return null;

    const updatedKey = connection.providerCode === 'aws' ? 'awsMetricDefinitions' : 'ociMetricDefinitions';
    const metadata = isJsonObject(connection.metadata)
      ? { ...(connection.metadata as Record<string, unknown>) }
      : {};
    const existing = !input.replace && Array.isArray(metadata[updatedKey]) ? metadata[updatedKey] : [];
    const definitions = [...new Map(
      [...existing, ...input.definitions].map((definition) => [JSON.stringify(definition), definition]),
    ).values()];
    metadata[updatedKey] = definitions;
    await this.prisma.cloudConnection.update({
      where: { id: connection.id },
      data: { metadata: metadata as Prisma.InputJsonValue },
    });
    return {
      cloudConnectionId: connection.id,
      providerCode: connection.providerCode,
      updatedKey,
      configuredCount: definitions.length,
      replaced: input.replace,
    };
  }
}

function toIngestionJobSummary(job: {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly status: IngestionJobSummary['status'];
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): IngestionJobSummary {
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
    ...(credential.externalPrincipalId !== null
      ? { externalPrincipalId: credential.externalPrincipalId }
      : {}),
    createdAt: credential.createdAt,
    ...(credential.disabledAt !== null ? { disabledAt: credential.disabledAt } : {}),
    ...(credential.revokedAt !== null ? { revokedAt: credential.revokedAt } : {}),
  };
}

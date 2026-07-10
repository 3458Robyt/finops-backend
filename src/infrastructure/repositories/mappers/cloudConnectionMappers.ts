/**
 * Mappers puros del repositorio de conexiones cloud.
 *
 * Responsabilidad: aislar la traducción `fila Prisma` -> modelo de dominio de
 * las entidades del catálogo de proveedores y de las conexiones cloud, junto
 * con el helper puro de validación de objetos JSON. Todas las funciones aquí
 * son puras (no dependen de `this` ni del cliente Prisma) para mantener el
 * repositorio enfocado en el acceso a datos.
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 */
import type {
  CloudConnectionSummary,
  ProviderCatalogEntry,
} from '../../../domain/models/CloudConnection.js';
import type {
  DataQualityCheckItem,
  IngestionJobHistoryItem,
} from '../../../domain/interfaces/ICloudConnectionRepository.js';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';

type PrismaProviderCatalog = Awaited<
  ReturnType<PrismaClient['providerCatalog']['findUnique']>
>;

type PrismaCloudConnection = Awaited<
  ReturnType<PrismaClient['cloudConnection']['findUnique']>
>;

type PrismaIngestionJob = Awaited<
  ReturnType<PrismaClient['ingestionJob']['findUnique']>
>;

type PrismaDataQualityCheck = Awaited<
  ReturnType<PrismaClient['dataQualityCheck']['findUnique']>
>;

/**
 * Mapea una fila del catálogo de proveedores al modelo de dominio
 * {@link ProviderCatalogEntry}.
 *
 * Casos borde: los campos anulables (`defaultFocusVersion`,
 * `documentationUrl`) solo se incluyen cuando no son `null`.
 *
 * @param provider Fila no nula del catálogo de proveedores de Prisma.
 * @returns Entrada del catálogo de dominio.
 */
export function mapProvider(provider: NonNullable<PrismaProviderCatalog>): ProviderCatalogEntry {
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

/**
 * Mapea una fila de `cloud_connections` al modelo de dominio
 * {@link CloudConnectionSummary}.
 *
 * Casos borde: `defaultRegion` y `lastValidatedAt` solo se incluyen cuando no
 * son `null`; `metadata` solo se incluye cuando es un objeto JSON (no
 * arreglo ni primitivo), validado con {@link isJsonObject}.
 *
 * @param connection Fila no nula de conexión cloud de Prisma.
 * @returns Resumen de conexión de dominio.
 */
export function mapCloudConnection(
  connection: NonNullable<PrismaCloudConnection>,
): CloudConnectionSummary {
  return {
    id: connection.id,
    tenantId: connection.tenantId,
    providerCode: connection.providerCode,
    rootExternalId: connection.rootExternalId,
    name: connection.name,
    status: connection.status,
    ...(connection.defaultRegion !== null ? { defaultRegion: connection.defaultRegion } : {}),
    ...(isJsonObject(connection.metadata)
      ? { metadata: connection.metadata as Record<string, unknown> }
      : {}),
    ...(connection.lastValidatedAt !== null ? { lastValidatedAt: connection.lastValidatedAt } : {}),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

/**
 * Determina si un valor JSON de Prisma es un objeto plano (no `null`, no
 * arreglo). Se usa para decidir si un campo JSON puede tratarse como
 * `Record<string, unknown>` antes de exponerlo en el dominio.
 *
 * @param value Valor JSON (o `null`) a evaluar.
 * @returns `true` si es un objeto JSON; `false` en caso contrario.
 */
export function isJsonObject(value: Prisma.JsonValue | null): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Mapea una fila de `ingestion_jobs` al elemento de historial de dominio
 * {@link IngestionJobHistoryItem}.
 *
 * Casos borde: `errorMessage` solo se incluye cuando no es `null`.
 *
 * @param job Fila no nula de trabajo de ingesta de Prisma.
 * @returns Elemento de historial de ingesta de dominio.
 */
export function toIngestionJobHistoryItem(
  job: NonNullable<PrismaIngestionJob>,
): IngestionJobHistoryItem {
  return {
    id: job.id,
    cloudConnectionId: job.cloudConnectionId,
    sourceType: job.sourceType,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    targetStart: job.targetStart,
    targetEnd: job.targetEnd,
    ...(job.errorMessage !== null ? { errorMessage: job.errorMessage } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * Mapea una fila de `data_quality_checks` al elemento de dominio
 * {@link DataQualityCheckItem}.
 *
 * Casos borde: `cloudConnectionId` y `expectedAt` solo se incluyen cuando no
 * son `null`; `details` solo cuando es un objeto JSON (ver {@link isJsonObject}).
 *
 * @param check Fila no nula de control de calidad de Prisma.
 * @returns Elemento de control de calidad de dominio.
 */
export function toDataQualityCheckItem(
  check: NonNullable<PrismaDataQualityCheck>,
): DataQualityCheckItem {
  return {
    id: check.id,
    ...(check.cloudConnectionId !== null ? { cloudConnectionId: check.cloudConnectionId } : {}),
    sourceType: check.sourceType,
    checkName: check.checkName,
    status: check.status,
    observedAt: check.observedAt,
    ...(check.expectedAt !== null ? { expectedAt: check.expectedAt } : {}),
    ...(isJsonObject(check.details)
      ? { details: check.details as Record<string, unknown> }
      : {}),
  };
}

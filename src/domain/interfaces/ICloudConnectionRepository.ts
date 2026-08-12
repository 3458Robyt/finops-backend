import type {
  CloudConnectionSummary,
  DataQualityStatus,
  IngestionHealthSummary,
  IngestionSourceType,
  ProviderCatalogEntry,
  ProviderCode,
} from '../models/CloudConnection.js';
import type { CloudIngestionConnection } from './ICloudIngestionProvider.js';
import type {
  ICloudConnectionCatalogRepository,
  ICloudConnectionConfigurationRepository,
  ICloudIngestionRepository,
} from './cloudConnectionRepositoryCapabilities.js';

/**
 * Datos de entrada para crear una conexión cloud de un tenant.
 *
 * Representa el vínculo entre un tenant y una cuenta raíz de un proveedor cloud.
 */
export interface CreateCloudConnectionInput {
  readonly tenantId: string;
  /** Código del proveedor cloud (e.g., AWS, OCI) al que pertenece la conexión. */
  readonly providerCode: ProviderCode;
  /** Identificador externo de la cuenta/organización raíz en el proveedor. */
  readonly rootExternalId: string;
  /** Nombre legible asignado a la conexión. */
  readonly name: string;
  /** Región por defecto usada para operaciones que la requieran; opcional. */
  readonly defaultRegion?: string;
}

/**
 * Datos de entrada para encolar un trabajo de ingesta de costos.
 *
 * Define el rango temporal objetivo y el origen de los datos a importar.
 */
export interface CreateIngestionJobInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  /** Tipo de fuente de ingesta (e.g., export de facturación, API). */
  readonly sourceType: IngestionSourceType;
  /** Usuario que solicitó la ingesta; opcional cuando es disparada por el sistema. */
  readonly requestedByUserId?: string;
  /** Inicio del rango temporal a ingerir (inclusivo). */
  readonly targetStart: Date;
  /** Fin del rango temporal a ingerir. */
  readonly targetEnd: Date;
  /** Número máximo de intentos antes de marcar el trabajo como fallido; opcional. */
  readonly maxAttempts?: number;
}

export interface IngestionJobRangeQuery {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly targetStart: Date;
  readonly targetEnd: Date;
}

export interface IngestionJobWindowItem {
  readonly id: string;
  readonly sourceType: IngestionSourceType;
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  readonly targetStart: Date;
  readonly targetEnd: Date;
}

/**
 * Resumen del estado de un trabajo de ingesta.
 */
export interface IngestionJobSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  /** Estado actual del ciclo de vida del trabajo de ingesta. */
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  readonly targetStart: Date;
  readonly targetEnd: Date;
  /** Cantidad de intentos ya ejecutados. */
  readonly attempts: number;
  /** Cantidad máxima de intentos permitidos. */
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Elemento del historial de trabajos de ingesta a nivel tenant.
 *
 * Proyección de solo lectura de un `ingestion_jobs` para mostrar el historial
 * cronológico de ingestas del tenant (todas sus conexiones), incluyendo el
 * detalle de reintentos y el mensaje de error cuando el trabajo falló.
 */
export interface IngestionJobHistoryItem {
  readonly id: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  /** Estado actual del ciclo de vida del trabajo de ingesta. */
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  /** Cantidad de intentos ya ejecutados. */
  readonly attempts: number;
  /** Cantidad máxima de intentos permitidos. */
  readonly maxAttempts: number;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  /** Mensaje de error del último intento fallido, si lo hubo. */
  readonly errorMessage?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Elemento de control de calidad de datos a nivel tenant.
 *
 * Proyección de solo lectura de un `data_quality_checks` para mostrar el
 * resultado de los controles de calidad ejecutados sobre las fuentes de datos
 * del tenant (frescura, completitud, etc.).
 */
export interface DataQualityCheckItem {
  readonly id: string;
  /** Conexión cloud asociada al control, si aplica. */
  readonly cloudConnectionId?: string;
  readonly sourceType: IngestionSourceType;
  /** Nombre del control de calidad ejecutado. */
  readonly checkName: string;
  /** Resultado del control. */
  readonly status: DataQualityStatus;
  /** Fecha en la que se observó/ejecutó el control. */
  readonly observedAt: Date;
  /** Fecha en la que se esperaba el dato, si aplica (controles de frescura). */
  readonly expectedAt?: Date;
  /** Detalles adicionales del control (estructura libre, solo lectura). */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface IngestionReadinessIssue {
  readonly provider: ProviderCode | 'global';
  readonly connectionId?: string;
  readonly severity: 'INFO' | 'WARNING' | 'BLOCKER';
  readonly capability: 'CONNECTION' | 'CREDENTIALS' | 'INVENTORY' | 'COSTS' | 'METRICS' | 'STORAGE' | 'JOBS';
  readonly message: string;
  readonly affectedData: readonly string[];
  readonly action: string;
  readonly actionCode: 'CREATE_CONNECTION' | 'CONFIGURE_CREDENTIALS' | 'VALIDATE_ACCESS' | 'CONFIGURE_METRICS' | 'CONFIGURE_FOCUS' | 'RETRY_FAILED_JOBS';
}

export interface IngestionReadinessConnectionSummary {
  readonly id: string;
  readonly name: string;
  readonly providerCode: ProviderCode;
  readonly defaultRegion?: string;
  readonly lastValidatedAt?: Date;
  readonly onboardingStatus: 'NO_CREDENTIAL' | 'REQUIRES_VALIDATION' | 'SYNCING' | 'PARTIAL' | 'READY' | 'REQUIRES_ATTENTION';
  readonly credentialPurposes: readonly string[];
  readonly capabilities: readonly {
    readonly capability: string;
    readonly status: 'AVAILABLE' | 'NOT_CONFIGURED' | 'DENIED' | 'ERROR';
    readonly message: string;
    readonly checkedAt?: Date;
  }[];
  readonly metadataCounts: Readonly<Record<string, number>>;
  readonly recentJobs: readonly {
    readonly id: string;
    readonly sourceType: IngestionSourceType;
    readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
    readonly targetStart: Date;
    readonly targetEnd: Date;
    readonly completedAt?: Date;
    readonly hasError: boolean;
    readonly summary: Readonly<Record<string, unknown>> | null;
  }[];
}

export interface IngestionReadinessSummary {
  readonly ok: boolean;
  readonly generatedAt: Date;
  readonly connections: readonly IngestionReadinessConnectionSummary[];
  readonly issues: readonly IngestionReadinessIssue[];
}

export interface ConfigureFocusSourceForConnectionInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly mode: 'location' | 'object';
  readonly values: Readonly<Record<string, string>>;
  readonly replace: boolean;
}

export interface ConfigureFocusSourceForConnectionResult {
  readonly cloudConnectionId: string;
  readonly providerCode: ProviderCode;
  readonly mode: 'location' | 'object';
  readonly updatedKey: string;
  readonly configuredCount: number;
  readonly replaced: boolean;
}

export interface UpdateCloudConnectionInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly name: string;
  readonly defaultRegion?: string;
}

export type BillingSourceMode = 'AUTO' | 'FOCUS' | 'PROVIDER_API';

export type CloudCredentialPurpose =
  | 'OPERATIONAL'
  | 'BILLING_EXPORT_READ'
  | 'INVENTORY_READ'
  | 'METRICS_READ'
  | 'STORAGE_READ';

export interface StoreCloudCredentialInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly purpose: CloudCredentialPurpose;
  readonly label: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly externalPrincipalId?: string;
}

export interface CloudCredentialSummary {
  readonly id: string;
  readonly purpose: CloudCredentialPurpose;
  readonly status: 'ACTIVE' | 'DISABLED' | 'REVOKED' | 'EXPIRED';
  readonly label: string;
  readonly externalPrincipalId?: string;
  readonly createdAt: Date;
  readonly disabledAt?: Date;
  readonly revokedAt?: Date;
}

export interface CreateCloudAuditEventInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: 'CLOUD_CONNECTION' | 'CLOUD_CREDENTIAL';
  readonly entityId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ConfigureBillingSourceForConnectionInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly mode: BillingSourceMode;
}

export interface ConfigureBillingSourceForConnectionResult {
  readonly cloudConnectionId: string;
  readonly providerCode: ProviderCode;
  readonly mode: BillingSourceMode;
}

export interface ConfigureMetricDefinitionsForConnectionInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly definitions: readonly Readonly<Record<string, unknown>>[];
  readonly replace: boolean;
}

export interface ConfigureMetricDefinitionsForConnectionResult {
  readonly cloudConnectionId: string;
  readonly providerCode: ProviderCode;
  readonly updatedKey: 'awsMetricDefinitions' | 'ociMetricDefinitions';
  readonly configuredCount: number;
  readonly replaced: boolean;
}

/**
 * Contrato de repositorio para conexiones cloud y trabajos de ingesta.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en la capa de
 * infraestructura. Gestiona el catálogo de proveedores, las conexiones de cada
 * tenant y la programación/seguimiento de la ingesta de datos de costo.
 */
export interface ICloudConnectionRepository
  extends ICloudConnectionCatalogRepository,
    ICloudIngestionRepository,
    ICloudConnectionConfigurationRepository {}

import type {
  DataQualityStatus,
  IngestionDataOutcome,
  IngestionHealthSummary,
  IngestionSourceType,
  ProviderCode,
} from '../models/CloudConnection.js';

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
  /** Lower values run first; source defaults keep interactive inventory/billing ahead of long metric backfills. */
  readonly priority?: number;
  /** Fingerprint of the immutable ingestion configuration used by this job. */
  readonly configurationHash?: string;
  /** Non-secret execution context, such as statistic profile and resolution. */
  readonly requestContext?: Readonly<Record<string, unknown>>;
}

export interface IngestionJobRangeQuery {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly configurationHash?: string;
}

export interface IngestionJobWindowItem {
  readonly id: string;
  readonly sourceType: IngestionSourceType;
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
  /** Estado independiente de la proyección de resúmenes/rollups técnicos. */
  readonly projectionStatus?: 'NOT_REQUIRED' | 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  readonly projectionAttempts?: number;
  readonly projectionMaxAttempts?: number;
  readonly projectionAvailableAt?: Date;
  readonly projectionStartedAt?: Date;
  readonly projectionCompletedAt?: Date;
  readonly projectionErrorMessage?: string;
  readonly dataOutcome?: IngestionDataOutcome;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly configurationHash?: string;
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
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
  readonly dataOutcome?: IngestionDataOutcome;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  /** Cantidad de intentos ya ejecutados. */
  readonly attempts: number;
  /** Cantidad máxima de intentos permitidos. */
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly configurationHash?: string;
  readonly requestContext?: Readonly<Record<string, unknown>>;
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
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
  /** Estado independiente de la proyección de resúmenes/rollups técnicos. */
  readonly projectionStatus: 'NOT_REQUIRED' | 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  readonly projectionAttempts: number;
  readonly projectionMaxAttempts: number;
  readonly projectionAvailableAt?: Date;
  readonly projectionStartedAt?: Date;
  readonly projectionCompletedAt?: Date;
  readonly projectionErrorMessage?: string;
  /** Cantidad de intentos ya ejecutados. */
  readonly attempts: number;
  /** Cantidad máxima de intentos permitidos. */
  readonly maxAttempts: number;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  /** Mensaje de error del último intento fallido, si lo hubo. */
  readonly errorMessage?: string;
  readonly progress?: Readonly<Record<string, unknown>>;
  readonly resultSummary?: Readonly<Record<string, unknown>>;
  readonly priority: number;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly availableAt: Date;
  readonly cancelRequestedAt?: Date;
  readonly archivedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type IngestionMetricCoverageStatus = 'UNKNOWN' | 'COVERED' | 'PARTIAL' | 'NO_DATA' | 'FAILED';

export interface IngestionMetricCoverageQuery {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly startDate?: Date;
  readonly endDate?: Date;
  readonly status?: IngestionMetricCoverageStatus;
  readonly limit: number;
}

export interface IngestionMetricCoverageWindowItem {
  readonly id: string;
  readonly cloudConnectionId: string;
  readonly cloudMetricDefinitionId?: string;
  readonly ingestionJobId?: string;
  readonly streamKey: string;
  readonly providerNamespace: string;
  readonly regionId: string;
  readonly externalResourceId: string;
  readonly metricName: string;
  readonly statistic: string;
  readonly granularitySeconds: number;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly status: IngestionMetricCoverageStatus;
  readonly expectedSamples: number;
  readonly observedSamples: number;
  readonly missingSamples: number;
  readonly configurationHash: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly checkedAt?: Date;
}

export interface IngestionMetricCoverageSummary {
  readonly totalWindows: number;
  readonly coveredWindows: number;
  readonly partialWindows: number;
  readonly noDataWindows: number;
  readonly failedWindows: number;
  readonly unknownWindows: number;
  readonly expectedSamples: number;
  readonly observedSamples: number;
  readonly missingSamples: number;
  readonly returnedWindows: number;
}

export interface IngestionMetricCoverageResult {
  readonly generatedAt: Date;
  readonly connectionId: string;
  readonly filters: {
    readonly startDate?: Date;
    readonly endDate?: Date;
    readonly status?: IngestionMetricCoverageStatus;
  };
  readonly summary: IngestionMetricCoverageSummary;
  readonly windows: readonly IngestionMetricCoverageWindowItem[];
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
  readonly lastValidationAttemptAt?: Date;
  readonly onboardingStatus: 'NO_CREDENTIAL' | 'REQUIRES_VALIDATION' | 'SYNCING' | 'PARTIAL' | 'READY' | 'REQUIRES_ATTENTION';
  readonly credentialPurposes: readonly string[];
  readonly authentication?: {
    readonly status: 'VERIFIED' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NOT_CONFIGURED';
    readonly message: string;
    readonly checkedAt?: Date;
  };
  readonly capabilities: readonly {
    readonly capability: string;
    readonly status: 'AVAILABLE' | 'NOT_CONFIGURED' | 'DENIED' | 'BLOCKED' | 'ERROR';
    readonly message: string;
    readonly checkedAt?: Date;
  }[];
  readonly metadataCounts: Readonly<Record<string, number>>;
  readonly recentJobs: readonly {
    readonly id: string;
    readonly sourceType: IngestionSourceType;
    readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
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
  readonly operational?: IngestionOperationalReadiness;
}

export type IngestionOperationalJobState = 'IDLE' | 'WAITING_FOR_WORKER' | 'QUEUED' | 'RUNNING' | 'CANCEL_REQUESTED' | 'STALE';

export interface IngestionOperationalReadiness {
  readonly state: IngestionOperationalJobState;
  readonly queue: Readonly<Record<'pending' | 'running' | 'cancelRequested' | 'staleRunning', number>>;
  readonly oldestPendingAt?: Date;
  readonly worker: {
    readonly available: boolean;
    readonly processId?: string;
    readonly processRole?: string;
    readonly lastHeartbeatAt?: Date;
  };
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
  /** Fingerprint derived from the credential material; never a user secret. */
  readonly keyFingerprint?: string;
  readonly initialStatus?: 'PENDING' | 'ACTIVE';
}

export interface CloudCredentialSummary {
  readonly id: string;
  readonly purpose: CloudCredentialPurpose;
  readonly status: 'PENDING' | 'ACTIVE' | 'DISABLED' | 'REVOKED' | 'EXPIRED' | 'INVALID';
  readonly label: string;
  readonly externalPrincipalId?: string;
  /** OCI public-key fingerprint, safe to display for comparison with the provider. */
  readonly keyFingerprint?: string;
  readonly createdAt: Date;
  readonly disabledAt?: Date;
  readonly revokedAt?: Date;
  readonly validationStatus?: 'VERIFIED' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NOT_CONFIGURED';
  readonly validationMessage?: string;
  readonly validationAttemptedAt?: Date;
  /** Present only in the store response; omitted from ordinary list/validation summaries. */
  readonly reused?: boolean;
  readonly nextAction?: 'VALIDATE' | 'NONE';
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

import type { CloudProvider } from '../../generated/prisma/client.js';
import type { IngestionDataOutcome, IngestionSourceType, ProviderCode } from '../models/CloudConnection.js';

export interface CloudIngestionConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly providerCode: ProviderCode;
  readonly rootExternalId: string;
  readonly defaultRegion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly credentials: readonly CloudIngestionCredential[];
}

export interface CloudIngestionCredential {
  readonly purpose:
    | 'OPERATIONAL'
    | 'BILLING_EXPORT_READ'
    | 'INVENTORY_READ'
    | 'METRICS_READ'
    | 'STORAGE_READ'
    | 'STORAGE_WRITE';
  readonly payload: Readonly<Record<string, unknown>>;
  readonly externalPrincipalId?: string;
}

export type CloudCapability = 'IDENTITY' | 'INVENTORY' | 'COSTS' | 'METRICS' | 'STORAGE';

export type CloudAuthenticationStatus = 'VERIFIED' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NOT_CONFIGURED';

export interface CloudAuthenticationValidation {
  readonly status: CloudAuthenticationStatus;
  readonly message: string;
  readonly checkedAt: Date;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface CloudCapabilityValidation {
  readonly capability: CloudCapability;
  readonly status: 'AVAILABLE' | 'NOT_CONFIGURED' | 'DENIED' | 'BLOCKED' | 'ERROR';
  readonly message: string;
  readonly checkedAt: Date;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface CloudConnectionValidationResult {
  readonly providerCode: ProviderCode;
  readonly authentication?: CloudAuthenticationValidation;
  readonly capabilities: readonly CloudCapabilityValidation[];
}

export interface FocusSourcePreviewResult {
  readonly providerCode: ProviderCode;
  readonly configuredLocations: number;
  readonly configuredObjects: number;
  readonly discoveredObjects: number;
  readonly approximateBytes: number;
  readonly sizedObjects: number;
  readonly supportedFormats: readonly ['csv', 'csv.gz'];
  readonly errors: readonly string[];
  readonly earliestObjectAt?: Date;
  readonly latestObjectAt?: Date;
  readonly objects: readonly {
    readonly name: string;
    readonly location: string;
    readonly source: 'configured' | 'discovered';
    readonly sizeBytes?: number;
    readonly lastModified?: Date;
  }[];
}

export interface CloudIngestionJobContext {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly targetStart: Date;
  readonly targetEnd: Date;
  /** Token de fencing: intento con el que el worker reclamó el job. */
  readonly attempt: number;
  /** Hash de la configuración de ingesta con la que se creó el job. */
  readonly configurationHash?: string;
  /** Opciones inmutables de ejecución, sin secretos. */
  readonly requestContext?: Readonly<Record<string, unknown>>;
  readonly connection: CloudIngestionConnection;
}

export interface NormalizedFocusCostLineItem {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly provider: CloudProvider;
  readonly focusVersion: string;
  readonly chargePeriodStart: Date;
  readonly chargePeriodEnd: Date;
  readonly billingPeriodStart?: Date;
  readonly billingPeriodEnd?: Date;
  readonly billingAccountId?: string;
  readonly subAccountId?: string;
  readonly serviceName: string;
  readonly resourceId: string;
  readonly regionId?: string;
  readonly chargeCategory: string;
  readonly billedCost: number;
  readonly effectiveCost?: number;
  readonly listCost?: number;
  readonly contractedCost?: number;
  readonly billingCurrency: string;
  readonly consumedQuantity?: number;
  readonly consumedUnit?: string;
  readonly tags?: Readonly<Record<string, unknown>>;
  readonly rawRow: Readonly<Record<string, unknown>>;
  readonly lineItemHash: string;
}

/** Cost returned by a provider API rather than a FOCUS export. */
export interface NormalizedProviderCostLineItem {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly provider: CloudProvider;
  readonly chargePeriodStart: Date;
  readonly chargePeriodEnd: Date;
  readonly billingAccountId?: string;
  readonly serviceName: string;
  readonly resourceId: string;
  readonly resourceName?: string;
  readonly regionId?: string;
  readonly compartmentId?: string;
  readonly skuName?: string;
  readonly skuPartNumber?: string;
  readonly billedCost: number;
  readonly billingCurrency: string;
  readonly consumedQuantity?: number;
  readonly consumedUnit?: string;
  readonly sourceMetric: string;
  readonly rawRow: Readonly<Record<string, unknown>>;
  readonly lineItemHash: string;
}

export interface NormalizedCloudResource {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly provider: CloudProvider;
  readonly externalResourceId: string;
  readonly name?: string;
  readonly resourceType: string;
  readonly serviceName: string;
  readonly regionId?: string;
  readonly status: 'ACTIVE' | 'STOPPED' | 'TERMINATED' | 'UNKNOWN';
  /** Provenance of the identity; inventory must outrank metric-derived data. */
  readonly identitySource?: string;
  readonly identityPriority?: number;
  readonly tags?: Readonly<Record<string, unknown>>;
  readonly rawResource?: Readonly<Record<string, unknown>>;
  readonly firstSeenAt?: Date;
  readonly lastSeenAt?: Date;
}

export interface NormalizedResourceMetricSample {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly provider: CloudProvider;
  readonly externalResourceId: string;
  readonly providerNamespace?: string;
  readonly regionId?: string;
  readonly compartmentId?: string;
  readonly dimensions?: Readonly<Record<string, string>>;
  readonly dimensionsHash?: string;
  readonly metricName: string;
  readonly metricUnit?: string;
  /** Statistic returned natively by the provider. Legacy samples default to MEAN. */
  readonly statistic?: MetricStatistic;
  readonly value: number;
  readonly sampledAt: Date;
  readonly granularitySeconds: number;
  readonly rawMetric?: Readonly<Record<string, unknown>>;
}

export interface IngestionObjectDescriptor {
  readonly objectUri: string;
  readonly objectEtag?: string;
  readonly objectVersion?: string;
  readonly sizeBytes?: number;
  readonly lastModified?: Date;
}

export type MetricStatistic =
  | 'MEAN'
  | 'MIN'
  | 'MAX'
  | 'P50'
  | 'P90'
  | 'P95'
  | 'P99'
  | 'SUM'
  | 'COUNT'
  | 'RATE'
  | 'LATEST';

export const METRIC_STATISTICS: readonly MetricStatistic[] = [
  'MEAN',
  'MIN',
  'MAX',
  'P50',
  'P90',
  'P95',
  'P99',
  'SUM',
  'COUNT',
  'RATE',
  'LATEST',
];

/**
 * Estadísticas OCI que se almacenan por defecto para análisis FinOps.
 *
 * `METRIC_STATISTICS` representa todo el vocabulario soportado; este perfil
 * controla el costo y volumen del ingestion profile estándar.
 */
export const OCI_CORE_METRIC_STATISTICS = ['MEAN', 'MIN', 'MAX', 'P95'] as const satisfies readonly MetricStatistic[];

export interface CloudIngestionResult {
  readonly apiCallCount: number;
  readonly objectsProcessed: number;
  readonly sourceObjects?: readonly IngestionObjectDescriptor[];
  readonly focusRows: readonly NormalizedFocusCostLineItem[];
  /** Optional streaming path for large FOCUS exports; consumed once by the worker. */
  readonly focusBatches?: AsyncIterable<readonly NormalizedFocusCostLineItem[]>;
  /** Direct billing API rows; never persisted to focus_cost_line_items. */
  readonly providerCostRows?: readonly NormalizedProviderCostLineItem[];
  readonly resources: readonly NormalizedCloudResource[];
  readonly metricSamples: readonly NormalizedResourceMetricSample[];
  /** Optional stream for high-volume technical samples; consumed by the worker in bounded batches. */
  readonly metricBatches?: AsyncIterable<readonly NormalizedResourceMetricSample[]>;
  readonly warnings: readonly string[];
  readonly coverage: Readonly<Record<string, unknown>>;
  /** Optional explicit result; legacy providers are classified centrally. */
  readonly dataOutcome?: IngestionDataOutcome;
}

export interface CloudIngestionProvider {
  readonly providerCode: ProviderCode;
  validate(connection: CloudIngestionConnection): Promise<CloudConnectionValidationResult>;
  previewFocus?(connection: CloudIngestionConnection, limit: number): Promise<FocusSourcePreviewResult>;
  collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult>;
}

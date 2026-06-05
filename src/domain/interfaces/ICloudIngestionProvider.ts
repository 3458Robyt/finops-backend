import type { CloudProvider } from '../../generated/prisma/client.js';
import type { IngestionSourceType, ProviderCode } from '../models/CloudConnection.js';

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

export interface CloudIngestionJobContext {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly targetStart: Date;
  readonly targetEnd: Date;
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
  readonly tags?: Readonly<Record<string, unknown>>;
  readonly rawResource?: Readonly<Record<string, unknown>>;
}

export interface NormalizedResourceMetricSample {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly provider: CloudProvider;
  readonly externalResourceId: string;
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly value: number;
  readonly sampledAt: Date;
  readonly granularitySeconds: number;
  readonly rawMetric?: Readonly<Record<string, unknown>>;
}

export interface CloudIngestionResult {
  readonly apiCallCount: number;
  readonly objectsProcessed: number;
  readonly focusRows: readonly NormalizedFocusCostLineItem[];
  readonly resources: readonly NormalizedCloudResource[];
  readonly metricSamples: readonly NormalizedResourceMetricSample[];
  readonly warnings: readonly string[];
  readonly coverage: Readonly<Record<string, unknown>>;
}

export interface CloudIngestionProvider {
  readonly providerCode: ProviderCode;
  collect(job: CloudIngestionJobContext): Promise<CloudIngestionResult>;
}

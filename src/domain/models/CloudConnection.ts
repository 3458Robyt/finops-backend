export type ProviderCode = 'aws' | 'oci' | 'azure' | 'gcp' | string;

export type CloudConnectionStatus = 'ACTIVE' | 'DISABLED';

export type IngestionSourceType =
  | 'BILLING_EXPORT'
  | 'INVENTORY'
  | 'TECHNICAL_METRIC'
  | 'AGENT_METRIC';

export type IngestionJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED';

export type DataQualityStatus = 'PASSED' | 'WARNING' | 'FAILED';

export interface ProviderCatalogEntry {
  readonly code: ProviderCode;
  readonly displayName: string;
  readonly provider: 'AWS' | 'OCI' | 'AZURE' | 'GCP' | 'CUSTOM';
  readonly capabilities: readonly string[];
  readonly defaultFocusVersion?: string;
  readonly documentationUrl?: string;
  readonly enabled: boolean;
}

export interface CloudConnectionSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly providerCode: ProviderCode;
  readonly rootExternalId: string;
  readonly name: string;
  readonly status: CloudConnectionStatus;
  readonly defaultRegion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly lastValidatedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IngestionHealthSummary {
  readonly cloudConnection: CloudConnectionSummary;
  readonly provider: ProviderCatalogEntry;
  readonly jobs: {
    readonly pending: number;
    readonly running: number;
    readonly failed: number;
  };
  readonly watermarks: readonly {
    readonly sourceType: IngestionSourceType;
    readonly watermarkStart?: Date;
    readonly watermarkEnd?: Date;
    readonly lastSuccessfulRunAt?: Date;
    readonly freshnessDeadlineAt?: Date;
  }[];
  readonly qualityChecks: readonly {
    readonly sourceType: IngestionSourceType;
    readonly checkName: string;
    readonly status: DataQualityStatus;
    readonly observedAt: Date;
    readonly expectedAt?: Date;
    readonly details?: Readonly<Record<string, unknown>>;
  }[];
}

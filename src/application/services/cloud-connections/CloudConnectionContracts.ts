import type {
  BillingSourceMode,
  CloudCredentialPurpose,
  CloudCredentialSummary,
  IngestionReadinessSummary,
  IngestionJobSummary,
} from '../../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudConnectionSummary,
  IngestionSourceType,
} from '../../../domain/models/CloudConnection.js';
import type {
  CloudConnectionValidationResult,
} from '../../../domain/interfaces/ICloudIngestionProvider.js';

export interface RegisterCloudConnectionInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly providerCode: string;
  readonly rootExternalId: string;
  readonly name: string;
  readonly defaultRegion?: string;
}

export interface QueueIngestionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  readonly targetStart: Date;
  readonly targetEnd: Date;
}

export interface QueueTechnicalBackfillInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly cloudConnectionId: string;
  readonly lookbackDays?: number;
  readonly windowHours?: number;
}

export interface TechnicalBackfillWindow {
  readonly targetStart: Date;
  readonly targetEnd: Date;
  readonly interval: '1m' | '5m' | '30m' | '1h';
}

export interface TechnicalBackfillResult {
  readonly cloudConnectionId: string;
  readonly sourceType: 'TECHNICAL_METRIC';
  readonly lookbackDays: number;
  readonly windowHours: number;
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly createdJobs: readonly IngestionJobSummary[];
  readonly skippedWindows: readonly TechnicalBackfillWindow[];
  readonly estimatedApiCalls: number;
}

export interface ConfigureFocusSourceInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly mode: 'location' | 'object';
  readonly values: Readonly<Record<string, string>>;
  readonly replace: boolean;
}
export interface ManageIngestionJobsInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
}

export interface UpdateCloudConnectionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly name: string;
  readonly defaultRegion?: string;
}

export interface ConfigureBillingSourceInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly mode: BillingSourceMode;
}

export interface ConfigureMetricDefinitionsInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly definitions: readonly unknown[];
  readonly replace: boolean;
}

export interface StoreOperationalCredentialInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly cloudConnectionId: string;
  readonly purpose: CloudCredentialPurpose;
  readonly label: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type CloudCredentialNextAction = 'VALIDATE' | 'NONE';

export interface ValidateCloudCredentialInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly credentialId: string;
  readonly userId?: string;
}

export interface ValidateCloudCredentialResult {
  readonly credential: CloudCredentialSummary;
  readonly validation: CloudConnectionValidationResult;
}

export interface CloudConnectionOnboardingDetail {
  readonly connection: CloudConnectionSummary;
  readonly credentials: readonly CloudCredentialSummary[];
  readonly readiness: IngestionReadinessSummary['connections'][number] | null;
  readonly issues: readonly (IngestionReadinessSummary['issues'][number])[];
}

export interface ActivateCloudConnectionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly billingLookbackDays?: number;
  readonly metricLookbackDays?: number;
  readonly metricWindowHours?: number;
}

export interface ActivateCloudConnectionResult {
  readonly cloudConnectionId: string;
  readonly createdJobs: readonly IngestionJobSummary[];
  readonly skipped: readonly IngestionSourceType[];
  readonly unavailable: readonly IngestionSourceType[];
}

export interface ValidateCloudConnectionInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly userId?: string;
}

export interface PreviewFocusSourceInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly cloudConnectionId: string;
  readonly limit?: number;
}

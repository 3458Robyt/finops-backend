import type {
  CloudConnectionSummary,
  IngestionHealthSummary,
  IngestionSourceType,
  ProviderCatalogEntry,
} from '../models/CloudConnection.js';
import type { CloudIngestionConnection } from './ICloudIngestionProvider.js';
import type {
  CloudCredentialSummary,
  CloudMetricDefinitionSummary,
  ConfigureBillingSourceForConnectionInput,
  ConfigureBillingSourceForConnectionResult,
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionInput,
  ConfigureMetricDefinitionsForConnectionResult,
  CreateCloudAuditEventInput,
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  DataQualityCheckItem,
  IngestionJobHistoryItem,
  IngestionMetricCoverageQuery,
  IngestionMetricCoverageResult,
  IngestionJobRangeQuery,
  IngestionJobSummary,
  IngestionJobWindowItem,
  IngestionReadinessSummary,
  StoreCloudCredentialInput,
  UpdateCloudConnectionInput,
} from './ICloudConnectionRepository.js';

/** Catálogo, ciclo de vida, credenciales y validación de conexiones cloud. */
export interface ICloudConnectionCatalogRepository {
  listProviderCatalog(): Promise<readonly ProviderCatalogEntry[]>;
  findProviderCatalog(providerCode: string): Promise<ProviderCatalogEntry | null>;
  createCloudConnection(input: CreateCloudConnectionInput): Promise<CloudConnectionSummary>;
  updateCloudConnection(input: UpdateCloudConnectionInput): Promise<CloudConnectionSummary | null>;
  findCloudConnectionForTenant(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudConnectionSummary | null>;
  listCloudConnectionsForTenant(tenantId: string): Promise<readonly CloudConnectionSummary[]>;
  setCloudConnectionStatus(
    tenantId: string,
    cloudConnectionId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<CloudConnectionSummary | null>;
  listCredentialSummaries(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<readonly CloudCredentialSummary[] | null>;
  storeCredential(input: StoreCloudCredentialInput): Promise<CloudCredentialSummary | null>;
  revokeCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
  ): Promise<CloudCredentialSummary | null>;
  getIngestionConnectionForTenant(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudIngestionConnection | null>;
  /** Read a candidate credential without making it available to ingestion. */
  getIngestionConnectionForCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
  ): Promise<CloudIngestionConnection | null>;
  /** Promote a previously validated candidate and disable the old one atomically. */
  promoteCredential(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
  ): Promise<CloudCredentialSummary | null>;
  /** Keep a candidate for a manual retry or mark it INVALID without displacing ACTIVE. */
  updateCredentialValidation(
    tenantId: string,
    cloudConnectionId: string,
    credentialId: string,
    status: 'PENDING' | 'INVALID',
    validationStatus: 'VERIFIED' | 'REJECTED' | 'RETRYABLE_ERROR' | 'NOT_CONFIGURED',
    message: string,
    attemptedAt: Date,
  ): Promise<CloudCredentialSummary | null>;
  saveConnectionValidation(
    tenantId: string,
    cloudConnectionId: string,
    validation: Readonly<Record<string, unknown>>,
    validatedAt: Date,
  ): Promise<CloudConnectionSummary | null>;
  createCloudAuditEvent(input: CreateCloudAuditEventInput): Promise<void>;
  markCloudConnectionValidated(cloudConnectionId: string, validatedAt: Date): Promise<void>;
  listEnabledMetricDefinitions?(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<readonly CloudMetricDefinitionSummary[]>;
}

/** Encolado, seguimiento, historial y readiness de ingestas. */
export interface ICloudIngestionRepository {
  createIngestionJob(input: CreateIngestionJobInput): Promise<IngestionJobSummary>;
  listIngestionJobsForConnectionRange(
    input: IngestionJobRangeQuery,
  ): Promise<readonly IngestionJobWindowItem[]>;
  listFailedIngestionJobsForConnection(
    tenantId: string,
    cloudConnectionId: string,
    sourceType?: IngestionSourceType,
  ): Promise<readonly IngestionJobWindowItem[]>;
  cancelPendingIngestionJobs(
    tenantId: string,
    cloudConnectionId: string,
    sourceType: IngestionSourceType,
  ): Promise<number>;
  getIngestionHealth(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<IngestionHealthSummary | null>;
  listIngestionJobsForTenant(
    tenantId: string,
    limit: number,
    includeArchived?: boolean,
  ): Promise<readonly IngestionJobHistoryItem[]>;
  getIngestionJobForTenant(tenantId: string, jobId: string): Promise<IngestionJobHistoryItem | null>;
  requestIngestionJobCancellation(
    tenantId: string,
    jobId: string,
    userId: string,
  ): Promise<IngestionJobHistoryItem | null>;
  archiveIngestionJob(
    tenantId: string,
    jobId: string,
    userId: string,
  ): Promise<IngestionJobHistoryItem | null>;
  listDataQualityChecksForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly DataQualityCheckItem[]>;
  listIngestionReadinessForTenant(tenantId: string): Promise<IngestionReadinessSummary>;
  listMetricCoverageForTenant(input: IngestionMetricCoverageQuery): Promise<IngestionMetricCoverageResult>;
}

/** Configuración explícita de fuentes FOCUS, billing y métricas. */
export interface ICloudConnectionConfigurationRepository {
  configureFocusSourceForConnection(
    input: ConfigureFocusSourceForConnectionInput,
  ): Promise<ConfigureFocusSourceForConnectionResult | null>;
  configureBillingSourceForConnection(
    input: ConfigureBillingSourceForConnectionInput,
  ): Promise<ConfigureBillingSourceForConnectionResult | null>;
  configureMetricDefinitionsForConnection(
    input: ConfigureMetricDefinitionsForConnectionInput,
  ): Promise<ConfigureMetricDefinitionsForConnectionResult | null>;
}

import type {
  CloudCredentialSummary,
  ConfigureBillingSourceForConnectionResult,
  ConfigureFocusSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionResult,
  DataQualityCheckItem,
  ICloudConnectionRepository,
  IngestionJobHistoryItem,
  IngestionMetricCoverageResult,
  IngestionJobSummary,
  IngestionReadinessSummary,
} from '../../domain/interfaces/ICloudConnectionRepository.js';
import type {
  CloudConnectionValidationResult,
  CloudIngestionProvider,
  FocusSourcePreviewResult,
} from '../../domain/interfaces/ICloudIngestionProvider.js';
import type {
  CloudConnectionSummary,
  IngestionHealthSummary,
  ProviderCatalogEntry,
} from '../../domain/models/CloudConnection.js';
import { CloudConnectionOnboarding } from './cloud-connections/CloudConnectionOnboarding.js';
import { CloudIngestionOrchestrator } from './cloud-connections/CloudIngestionOrchestrator.js';
import { CloudConnectionSourceConfiguration } from './cloud-connections/CloudConnectionSourceConfiguration.js';
import type {
  ActivateCloudConnectionInput,
  ActivateCloudConnectionResult,
  CloudConnectionOnboardingDetail,
  ConfigureBillingSourceInput,
  ConfigureFocusSourceInput,
  ConfigureMetricDefinitionsInput,
  ManageIngestionJobsInput,
  PreviewFocusSourceInput,
  QueueIngestionInput,
  QueueTechnicalBackfillInput,
  RegisterCloudConnectionInput,
  StoreOperationalCredentialInput,
  TechnicalBackfillResult,
  UpdateCloudConnectionInput,
  ValidateCloudCredentialInput,
  ValidateCloudCredentialResult,
  ValidateCloudConnectionInput,
} from './cloud-connections/CloudConnectionContracts.js';

export type * from './cloud-connections/CloudConnectionContracts.js';

/**
 * Backwards-compatible application facade. Onboarding/configuration and job
 * orchestration live behind separate deep modules while controllers keep one
 * stable entry point.
 */
export class CloudConnectionService {
  private readonly onboarding: CloudConnectionOnboarding;
  private readonly ingestion: CloudIngestionOrchestrator;
  private readonly sourceConfiguration: CloudConnectionSourceConfiguration;

  constructor(
    repository: ICloudConnectionRepository,
    providers: readonly CloudIngestionProvider[] = [],
  ) {
    this.onboarding = new CloudConnectionOnboarding(repository, providers);
    this.ingestion = new CloudIngestionOrchestrator(repository);
    this.sourceConfiguration = new CloudConnectionSourceConfiguration(repository);
  }

  public listProviders(): Promise<readonly ProviderCatalogEntry[]> {
    return this.onboarding.listProviders();
  }

  public listConnections(tenantId: string): Promise<readonly CloudConnectionSummary[]> {
    return this.onboarding.listConnections(tenantId);
  }

  public setConnectionStatus(input: Parameters<CloudConnectionOnboarding['setConnectionStatus']>[0]): Promise<CloudConnectionSummary> {
    return this.onboarding.setConnectionStatus(input);
  }

  public getOnboardingDetail(tenantId: string, cloudConnectionId: string): Promise<CloudConnectionOnboardingDetail> {
    return this.onboarding.getOnboardingDetail(tenantId, cloudConnectionId);
  }

  public storeOperationalCredential(input: StoreOperationalCredentialInput): Promise<CloudCredentialSummary> {
    return this.onboarding.storeOperationalCredential(input);
  }

  public revokeOperationalCredential(tenantId: string, cloudConnectionId: string, credentialId: string, userId?: string): Promise<CloudCredentialSummary> {
    return this.onboarding.revokeOperationalCredential(tenantId, cloudConnectionId, credentialId, userId);
  }

  public validateCredential(input: ValidateCloudCredentialInput): Promise<ValidateCloudCredentialResult> {
    return this.onboarding.validateCredential(input);
  }

  public registerConnection(input: RegisterCloudConnectionInput): Promise<CloudConnectionSummary> {
    return this.onboarding.registerConnection(input);
  }

  public updateConnection(input: UpdateCloudConnectionInput): Promise<CloudConnectionSummary> {
    return this.onboarding.updateConnection(input);
  }

  public validateConnection(input: ValidateCloudConnectionInput): Promise<CloudConnectionValidationResult> {
    return this.onboarding.validateConnection(input);
  }

  public previewFocusSource(input: PreviewFocusSourceInput): Promise<FocusSourcePreviewResult> {
    return this.onboarding.previewFocusSource(input);
  }

  public activateConnection(input: ActivateCloudConnectionInput): Promise<ActivateCloudConnectionResult> {
    return this.ingestion.activateConnection(input);
  }

  public queueIngestion(input: QueueIngestionInput): Promise<IngestionJobSummary> {
    return this.ingestion.queueIngestion(input);
  }

  public retryFailedIngestionJobs(input: ManageIngestionJobsInput): Promise<readonly IngestionJobSummary[]> {
    return this.ingestion.retryFailedIngestionJobs(input);
  }

  public cancelPendingIngestionJobs(input: ManageIngestionJobsInput): Promise<number> {
    return this.ingestion.cancelPendingIngestionJobs(input);
  }

  public queueTechnicalMetricBackfill(input: QueueTechnicalBackfillInput): Promise<TechnicalBackfillResult> {
    return this.ingestion.queueTechnicalMetricBackfill(input);
  }

  public getHealth(tenantId: string, cloudConnectionId: string): Promise<IngestionHealthSummary> {
    return this.ingestion.getHealth(tenantId, cloudConnectionId);
  }

  public listIngestionHistory(tenantId: string, limit?: number, includeArchived = false): Promise<readonly IngestionJobHistoryItem[]> {
    return this.ingestion.listIngestionHistory(tenantId, limit, includeArchived);
  }

  public getIngestionJob(tenantId: string, jobId: string): Promise<IngestionJobHistoryItem> {
    return this.ingestion.getIngestionJob(tenantId, jobId);
  }

  public cancelIngestionJob(tenantId: string, jobId: string, userId: string): Promise<IngestionJobHistoryItem> {
    return this.ingestion.cancelIngestionJob(tenantId, jobId, userId);
  }

  public archiveIngestionJob(tenantId: string, jobId: string, userId: string): Promise<IngestionJobHistoryItem> {
    return this.ingestion.archiveIngestionJob(tenantId, jobId, userId);
  }

  public listDataQualityChecks(tenantId: string, limit?: number): Promise<readonly DataQualityCheckItem[]> {
    return this.ingestion.listDataQualityChecks(tenantId, limit);
  }

  public getIngestionReadiness(tenantId: string): Promise<IngestionReadinessSummary> {
    return this.ingestion.getIngestionReadiness(tenantId);
  }

  public listMetricCoverage(
    tenantId: string,
    cloudConnectionId: string,
    input: Parameters<CloudIngestionOrchestrator['listMetricCoverage']>[2],
  ): Promise<IngestionMetricCoverageResult> {
    return this.ingestion.listMetricCoverage(tenantId, cloudConnectionId, input);
  }

  public configureFocusSource(input: ConfigureFocusSourceInput): Promise<ConfigureFocusSourceForConnectionResult> {
    return this.sourceConfiguration.configureFocusSource(input);
  }

  public configureBillingSource(input: ConfigureBillingSourceInput): Promise<ConfigureBillingSourceForConnectionResult> {
    return this.sourceConfiguration.configureBillingSource(input);
  }

  public configureMetricDefinitions(input: ConfigureMetricDefinitionsInput): Promise<ConfigureMetricDefinitionsForConnectionResult> {
    return this.sourceConfiguration.configureMetricDefinitions(input);
  }
}

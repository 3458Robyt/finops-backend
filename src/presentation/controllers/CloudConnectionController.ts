import type { CloudConnectionService } from "../../application/services/CloudConnectionService.js";
import { CloudConnectionManagementController } from "./CloudConnectionManagementController.js";
import { CloudIngestionController } from "./CloudIngestionController.js";

/** Stable facade that exposes cloud connection and ingestion HTTP handlers. */
export class CloudConnectionController {
  public readonly listProviders: CloudConnectionManagementController["listProviders"];
  public readonly listConnections: CloudConnectionManagementController["listConnections"];
  public readonly createConnection: CloudConnectionManagementController["createConnection"];
  public readonly getOnboardingDetail: CloudConnectionManagementController["getOnboardingDetail"];
  public readonly updateConnection: CloudConnectionManagementController["updateConnection"];
  public readonly setConnectionStatus: CloudConnectionManagementController["setConnectionStatus"];
  public readonly storeCredential: CloudConnectionManagementController["storeCredential"];
  public readonly revokeCredential: CloudConnectionManagementController["revokeCredential"];
  public readonly validateConnection: CloudConnectionManagementController["validateConnection"];
  public readonly previewFocusSource: CloudConnectionManagementController["previewFocusSource"];
  public readonly activateConnection: CloudConnectionManagementController["activateConnection"];
  public readonly configureBillingSource: CloudConnectionManagementController["configureBillingSource"];
  public readonly configureMetricDefinitions: CloudConnectionManagementController["configureMetricDefinitions"];
  public readonly queueIngestion: CloudIngestionController["queueIngestion"];
  public readonly queueTenantIngestion: CloudIngestionController["queueTenantIngestion"];
  public readonly queueTechnicalBackfill: CloudIngestionController["queueTechnicalBackfill"];
  public readonly getHealth: CloudIngestionController["getHealth"];
  public readonly listIngestionHistory: CloudIngestionController["listIngestionHistory"];
  public readonly listDataQuality: CloudIngestionController["listDataQuality"];
  public readonly getIngestionReadiness: CloudIngestionController["getIngestionReadiness"];
  public readonly configureFocusSource: CloudIngestionController["configureFocusSource"];
  public readonly retryFailedIngestionJobs: CloudIngestionController["retryFailedIngestionJobs"];
  public readonly cancelPendingIngestionJobs: CloudIngestionController["cancelPendingIngestionJobs"];

  constructor(cloudConnectionService: CloudConnectionService) {
    const management = new CloudConnectionManagementController(
      cloudConnectionService,
    );
    const ingestion = new CloudIngestionController(cloudConnectionService);
    this.listProviders = management.listProviders;
    this.listConnections = management.listConnections;
    this.createConnection = management.createConnection;
    this.getOnboardingDetail = management.getOnboardingDetail;
    this.updateConnection = management.updateConnection;
    this.setConnectionStatus = management.setConnectionStatus;
    this.storeCredential = management.storeCredential;
    this.revokeCredential = management.revokeCredential;
    this.validateConnection = management.validateConnection;
    this.previewFocusSource = management.previewFocusSource;
    this.activateConnection = management.activateConnection;
    this.configureBillingSource = management.configureBillingSource;
    this.configureMetricDefinitions = management.configureMetricDefinitions;
    this.queueIngestion = ingestion.queueIngestion;
    this.queueTenantIngestion = ingestion.queueTenantIngestion;
    this.queueTechnicalBackfill = ingestion.queueTechnicalBackfill;
    this.getHealth = ingestion.getHealth;
    this.listIngestionHistory = ingestion.listIngestionHistory;
    this.listDataQuality = ingestion.listDataQuality;
    this.getIngestionReadiness = ingestion.getIngestionReadiness;
    this.configureFocusSource = ingestion.configureFocusSource;
    this.retryFailedIngestionJobs = ingestion.retryFailedIngestionJobs;
    this.cancelPendingIngestionJobs = ingestion.cancelPendingIngestionJobs;
  }
}

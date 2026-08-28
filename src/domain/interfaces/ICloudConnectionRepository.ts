import type {
  ICloudConnectionCatalogRepository,
  ICloudConnectionConfigurationRepository,
  ICloudIngestionRepository,
} from './cloudConnectionRepositoryCapabilities.js';

export type {
  CreateCloudConnectionInput,
  CreateIngestionJobInput,
  IngestionJobRangeQuery,
  IngestionJobWindowItem,
  IngestionJobSummary,
  IngestionJobHistoryItem,
  IngestionMetricCoverageStatus,
  IngestionMetricCoverageQuery,
  IngestionMetricCoverageWindowItem,
  IngestionMetricCoverageSummary,
  IngestionMetricCoverageResult,
  DataQualityCheckItem,
  IngestionReadinessIssue,
  IngestionReadinessConnectionSummary,
  IngestionReadinessSummary,
  IngestionOperationalJobState,
  IngestionOperationalReadiness,
  ConfigureFocusSourceForConnectionInput,
  ConfigureFocusSourceForConnectionResult,
  UpdateCloudConnectionInput,
  BillingSourceMode,
  CloudCredentialPurpose,
  StoreCloudCredentialInput,
  CloudCredentialSummary,
  CreateCloudAuditEventInput,
  ConfigureBillingSourceForConnectionInput,
  ConfigureBillingSourceForConnectionResult,
  ConfigureMetricDefinitionsForConnectionInput,
  ConfigureMetricDefinitionsForConnectionResult
} from './cloudConnectionRepositoryTypes.js';

export type { CloudMetricDefinitionSummary } from './cloudConnectionRepositoryMetricTypes.js';

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

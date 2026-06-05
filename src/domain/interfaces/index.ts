/**
 * Barrel (índice de re-exportación) de la capa de interfaces de dominio.
 *
 * Centraliza la exportación pública de todos los puertos (contratos) y sus DTOs
 * asociados, de modo que las capas de aplicación e infraestructura importen las
 * abstracciones desde un único punto de entrada en lugar de hacerlo por módulo.
 *
 * En términos de Clean Architecture, este archivo expone las abstracciones del
 * dominio que sustentan el principio de inversión de dependencias (DIP): las
 * implementaciones concretas dependen de estos contratos, no al revés.
 *
 * @module domain/interfaces
 */
export { type ICloudProvider } from './ICloudProvider.js';
export {
  type CostMetricBatchContext,
  type CostMetricQuery,
  type ICostRepository,
} from './ICostRepository.js';
export {
  type AnalyticsFilters,
  type AnalyticsGroupBy,
  type CostAnomaly,
  type CostAnomalySeverity,
  type CostAnalyticsSnapshot,
  type CostAnalyticsUsageItem,
  type CostForecast,
  type CostTrend,
  type ICostAnalyticsRepository,
  type MonthlyCostPoint,
  type MonthlyUsagePoint,
  type UsageInsight,
} from './ICostAnalyticsRepository.js';
export {
  type AiGatewayMessage,
  type AiGatewayRequest,
  type AiMessageRole,
  type IAiGateway,
} from './IAiGateway.js';
export {
  type ActivateAgentProfileInput,
  type CreateAiContextTraceInput,
  type CreateContextBuildRunInput,
  type CreateTenantAgentRuleInput,
  type IAgentContextRepository,
} from './IAgentContextRepository.js';
export {
  type BuildAiContextInput,
  type BuiltAiContext,
  type IContextEngineService,
} from './IContextEngineService.js';
export {
  type IAgentLearningContextProvider,
  type IAgentLearningService,
  type AgentLearningContext,
  type AgentLearningSummary,
  type ProcessRecommendationDecisionInput,
  type RecommendationLearningResult,
} from './IAgentLearningService.js';
export {
  type CompleteAgentLearningEventInput,
  type CreateAgentLearningEventInput,
  type CreateAgentMemoryInput,
  type IAgentLearningRepository,
} from './IAgentLearningRepository.js';
export {
  type CreateCloudConnectionInput,
  type CreateIngestionJobInput,
  type ICloudConnectionRepository,
  type IngestionJobSummary,
} from './ICloudConnectionRepository.js';
export {
  type CloudIngestionConnection,
  type CloudIngestionCredential,
  type CloudIngestionJobContext,
  type CloudIngestionProvider,
  type CloudIngestionResult,
  type NormalizedCloudResource,
  type NormalizedFocusCostLineItem,
  type NormalizedResourceMetricSample,
} from './ICloudIngestionProvider.js';
export {
  type CloudProviderPlugin,
  type TemporaryAdminProvisioningInput,
  type TemporaryAdminProvisioningResult,
} from './ICloudProviderPlugin.js';
export { type IPasswordHasher } from './IPasswordHasher.js';
export {
  type CreateRecommendationDecisionResult,
  type CreateManualExecutionInput,
  type CreateRecommendationInput,
  type IRecommendationRepository,
  type RecommendationManualExecution,
  type RecommendationQuery,
  type RecommendationTimelineEvent,
  type SavingsKpis,
  type AdoptionKpis,
} from './IRecommendationRepository.js';
export {
  type CreateInAppNotificationInput,
  type INotificationRepository,
  type ListNotificationsQuery,
} from './INotificationRepository.js';
export {
  type CreateOrUpdateTelegramLinkInput,
  type CreateTelegramAuditEventInput,
  type CreateTelegramInteractionLogInput,
  type ITelegramRepository,
} from './ITelegramRepository.js';
export { type ITokenService, type TokenIssueResult } from './ITokenService.js';
export {
  type AuthUser,
  type CreateSessionInput,
  type IUserRepository,
} from './IUserRepository.js';

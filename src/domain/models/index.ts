/**
 * ═══════════════════════════════════════════════════════════════
 * Modelos de Dominio — Barrel Export
 * ═══════════════════════════════════════════════════════════════
 *
 * Punto único de reexportación de todos los modelos y tipos del dominio.
 * Permite importarlos desde `domain/models` sin acoplarse a la ruta de cada
 * archivo concreto. Solo reexporta tipos (no contiene lógica).
 *
 * @module domain/models
 */

/** Contexto de autenticación y roles de usuario. */
export { type AuthContext, type UserRole } from './AuthContext.js';
/** Métrica de costo canónica e independiente de proveedor. */
export { type InternalCostMetric } from './InternalCostMetric.js';
/** Recomendación FinOps de optimización de costos. */
export { type FinOpsRecommendation } from './FinOpsRecommendation.js';
/** Plan de ejecución de recomendaciones y auditoría de IA asociada. */
export {
  type AiAuditCheck,
  type AiAuditReport,
  type AiAuditVerdict,
  type RecommendationExecutionPlan,
} from './RecommendationExecutionPlan.js';
/** Eventos y memoria del aprendizaje del agente de IA. */
export {
  type AgentLearningEvent,
  type AgentLearningStatus,
  type AgentMemory,
  type AgentMemoryScope,
  type AgentMemoryType,
  type RecommendationFeedbackReason,
} from './AgentLearning.js';
/** Notificaciones internas (in-app) para usuarios. */
export {
  type InAppNotification,
  type InAppNotificationStatus,
  type InAppNotificationType,
} from './InAppNotification.js';
/** Integración con Telegram: vínculos de chat e historial de interacciones. */
export {
  type TelegramChatLink,
  type TelegramChatLinkStatus,
  type TelegramInteractionLog,
  type TelegramInteractionStatus,
  type TelegramLinkedUser,
} from './Telegram.js';
/** Contexto del agente de IA: perfiles de instrucciones, reglas y trazas de contexto. */
export {
  type AgentInstructionProfile,
  type AgentInstructionProfileStatus,
  type AgentInstructionRules,
  type AgentInstructionValidationReport,
  type AiContextOperation,
  type AiContextTrace,
  type ContextArtifact,
  type TenantAgentRule,
  type TenantAgentRuleStatus,
} from './AgentContext.js';
/** Conexiones cloud, catálogo de proveedores y salud de la ingesta. */
export {
  type CloudConnectionStatus,
  type CloudConnectionSummary,
  type DataQualityStatus,
  type IngestionHealthSummary,
  type IngestionJobStatus,
  type IngestionSourceType,
  type ProviderCatalogEntry,
  type ProviderCode,
} from './CloudConnection.js';

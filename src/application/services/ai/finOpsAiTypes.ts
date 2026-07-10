import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { CreateRecommendationInput } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Tipos de entrada/salida del servicio de IA FinOps
 * ═══════════════════════════════════════════════════════════════
 *
 * Contratos públicos de los casos de uso de {@link FinOpsAiService}
 * (chat, generación de recomendaciones y planes de ejecución). Se
 * aíslan en su propio módulo para mantener el servicio enfocado en la
 * orquestación; el servicio los reexporta para preservar su API pública.
 *
 * @module application/services/ai/finOpsAiTypes
 */

/**
 * Mensaje de una conversación de chat con el asistente IA.
 */
export interface AiChatMessage {
  /** Autor del mensaje: usuario humano o respuesta del asistente. */
  readonly role: 'user' | 'assistant';
  /** Contenido textual del mensaje. */
  readonly content: string;
}

/**
 * Entrada del caso de uso de chat FinOps.
 */
export interface AiChatInput {
  readonly tenantId: string;
  /** Usuario que origina la consulta (opcional; usado para trazas de observabilidad). */
  readonly userId?: string;
  /** Pregunta del usuario; se valida que no esté vacía. */
  readonly message: string;
  /** Historial de conversación previo (se normaliza y limita a los últimos turnos). */
  readonly history?: readonly AiChatMessage[];
}

/**
 * Respuesta del chat: la respuesta en lenguaje natural y el snapshot factual usado.
 */
export interface AiChatResponse {
  /** Respuesta del asistente en español. */
  readonly answer: string;
  /** Snapshot de analítica de costos usado como única fuente factual. */
  readonly snapshot: CostAnalyticsSnapshot;
}

/**
 * Entrada para la generación de recomendaciones FinOps por IA.
 */
export interface GenerateAiRecommendationsInput {
  readonly tenantId: string;
  /** Usuario que solicita la generación (opcional; para trazas). */
  readonly userId?: string;
  /** Si es `true`, las recomendaciones aprobadas se persisten; si no, son efímeras (preview). */
  readonly persist?: boolean;
}

/**
 * Respuesta de la generación de recomendaciones.
 */
export interface GenerateAiRecommendationsResponse {
  readonly recommendations: readonly FinOpsRecommendation[];
  /** Snapshot factual usado para generar y auditar las recomendaciones. */
  readonly snapshot: CostAnalyticsSnapshot;
  /** Indica si las recomendaciones fueron persistidas (true) o son solo preview (false). */
  readonly persisted: boolean;
}

/**
 * Entrada para generar un plan de ejecución de una recomendación existente.
 */
export interface GenerateExecutionPlanInput {
  readonly tenantId: string;
  readonly userId: string;
  /** Identificador de la recomendación para la que se generará el plan. */
  readonly recommendationId: string;
}

/** Borrador de recomendación generado por IA, sin el `tenantId` (se inyecta después). */
export type AiRecommendationDraft = Omit<CreateRecommendationInput, 'tenantId'>;

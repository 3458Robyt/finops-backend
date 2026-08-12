import type {
  AgentLearningStatus,
  RecommendationFeedbackReason,
  AgentMemory,
} from '../models/AgentLearning.js';
import type { AuthContext } from '../models/AuthContext.js';

/**
 * Datos de entrada para procesar la decisión de un usuario sobre una recomendación.
 *
 * Representa el feedback (aprobación o rechazo) que alimenta el aprendizaje del agente.
 */
export interface ProcessRecommendationDecisionInput {
  readonly tenantId: string;
  readonly recommendationId: string;
  /** Identificador de la decisión registrada que origina el evento de aprendizaje. */
  readonly decisionId: string;
  readonly userId: string;
  /** Sentido de la decisión del usuario sobre la recomendación. */
  readonly decision: 'APPROVED' | 'REJECTED';
  /** Motivo codificado de la decisión, usado para detectar patrones de aprendizaje. */
  readonly reasonCode: RecommendationFeedbackReason;
  /** Motivo en texto libre proporcionado por el usuario; opcional. */
  readonly reason?: string;
}

/**
 * Resultado del procesamiento de una decisión por parte del servicio de aprendizaje.
 */
export interface RecommendationLearningResult {
  /** Estado resultante del evento de aprendizaje (e.g., encolado, completado, fallido). */
  readonly status: AgentLearningStatus;
  /** Identificador del evento de aprendizaje generado; presente si se creó. */
  readonly eventId?: string;
  /** Mensaje de error cuando el procesamiento no fue satisfactorio; opcional. */
  readonly error?: string;
}

/**
 * Consulta para recuperar el contexto de aprendizaje relevante a una recomendación.
 */
export interface AgentLearningContextQuery {
  readonly tenantId: string;
  /** Texto de la consulta usado para recuperar memorias y casos similares. */
  readonly queryText: string;
  /** Número máximo de elementos a recuperar; opcional. */
  readonly limit?: number;
}

/**
 * Contexto de aprendizaje recuperado para enriquecer una operación de IA.
 *
 * Aporta referencias a memorias y casos previos junto con un resumen textual.
 */
export interface AgentLearningContext {
  /** Identificadores de las memorias del agente relevantes. */
  readonly memoryIds: readonly string[];
  /** Identificadores de los casos de aprendizaje relevantes. */
  readonly caseIds: readonly string[];
  /** Resumen textual del aprendizaje aplicable a la consulta. */
  readonly summary: string;
}

/**
 * Métricas agregadas del ciclo de feedback y aprendizaje del agente.
 *
 * Los nombres separan explícitamente la decisión humana (`feedback`) del
 * veredicto del auditor (`learning`); no debe interpretarse una tasa del
 * auditor como una tasa de aprobación del cliente.
 */
export interface AgentLearningSummaryStats {
  readonly totalEvents: number;
  readonly feedbackApproved: number;
  readonly feedbackRejected: number;
  readonly learningPending: number;
  readonly learningApproved: number;
  readonly learningRejected: number;
  readonly learningSkipped: number;
  readonly learningError: number;
  readonly activeMemories: number;
  readonly globalMemories: number;
  /** Candidatos globales en shadow, fuera del contexto activo. */
  readonly shadowMemories: number;
}

/**
 * Resumen del estado de aprendizaje de un tenant.
 *
 * Agrupa las memorias consolidadas y los eventos de aprendizaje recientes,
 * útil para paneles de observabilidad del agente.
 */
export interface AgentLearningSummary {
  /** Métricas agregadas del feedback humano y de la auditoría del aprendizaje. */
  readonly stats: AgentLearningSummaryStats;
  /** Memorias consolidadas del agente para el tenant. */
  readonly memories: readonly {
    readonly id: string;
    /** Alcance de la memoria (e.g., global o por tenant). */
    readonly scope: string;
    /** Tipo de memoria (e.g., preferencia, restricción). */
    readonly memoryType: string;
    readonly content: string;
    /** Nivel de confianza asociado a la memoria. */
    readonly confidence: number;
    readonly createdAt: Date;
  }[];
  /** Eventos de aprendizaje registrados para el tenant. */
  readonly events: readonly {
    readonly id: string;
    readonly recommendationId: string;
    readonly decisionId: string;
    /** Estado del evento de aprendizaje. */
    readonly status: AgentLearningStatus;
    readonly createdAt: Date;
  }[];
}

/**
 * Contrato proveedor de contexto de aprendizaje.
 *
 * Interfaz segregada (ISP) que expone únicamente la capacidad de recuperar
 * contexto de aprendizaje, para que los consumidores que solo necesitan leer
 * no dependan de las operaciones de escritura del servicio completo.
 */
export interface IAgentLearningContextProvider {
  /**
   * Recupera el contexto de aprendizaje relevante a una recomendación.
   *
   * @param query - Tenant, texto de consulta y límite opcional.
   * @returns Contexto de aprendizaje con referencias a memorias, casos y resumen.
   */
  getRecommendationLearningContext(query: AgentLearningContextQuery): Promise<AgentLearningContext>;
}

/**
 * Contrato del servicio de aprendizaje del agente.
 *
 * Puerto de dominio que orquesta el ciclo de aprendizaje a partir del feedback
 * sobre recomendaciones. Extiende {@link IAgentLearningContextProvider} para
 * añadir el encolado y procesamiento de decisiones, además de la consulta de
 * resúmenes. La implementación concreta reside en la capa de aplicación.
 */
export interface IAgentLearningService extends IAgentLearningContextProvider {
  /**
   * Encola una decisión de recomendación para su procesamiento asíncrono.
   *
   * @param input - Datos de la decisión a encolar.
   * @returns Resultado con el estado del encolado y el identificador del evento.
   */
  queueRecommendationDecision(input: ProcessRecommendationDecisionInput): Promise<RecommendationLearningResult>;

  /**
   * Procesa un evento de aprendizaje previamente encolado.
   *
   * @param eventId - Identificador del evento de aprendizaje encolado.
   * @returns Resultado del procesamiento.
   */
  processQueuedRecommendationDecision(eventId: string): Promise<RecommendationLearningResult>;

  /**
   * Procesa una decisión de recomendación de forma síncrona (sin pasar por la cola).
   *
   * @param input - Datos de la decisión a procesar.
   * @returns Resultado del procesamiento.
   */
  processRecommendationDecision(input: ProcessRecommendationDecisionInput): Promise<RecommendationLearningResult>;

  /**
   * Obtiene el resumen de aprendizaje de un tenant.
   *
   * @param tenantId - Tenant cuyo resumen se solicita.
   * @returns Resumen con memorias y eventos de aprendizaje.
   */
  getLearningSummary(tenantId: string): Promise<AgentLearningSummary>;

  /** Revierte una memoria activa sin eliminar el evento de aprendizaje original. */
  deactivateMemory?(actor: AuthContext, memoryId: string): Promise<AgentMemory>;
}

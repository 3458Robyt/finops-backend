import type {
  AgentLearningEvent,
  AgentLearningStatus,
  AgentMemory,
  AgentMemoryScope,
  AgentMemoryType,
  RecommendationFeedbackReason,
} from '../models/AgentLearning.js';
import type {
  AgentLearningContext,
  AgentLearningSummary,
} from './IAgentLearningService.js';

/**
 * Datos de entrada para crear un evento de aprendizaje a partir de una decisión.
 *
 * Captura una instantánea de la recomendación y del feedback del usuario, de modo
 * que el evento sea autosuficiente para el análisis posterior del agente.
 */
export interface CreateAgentLearningEventInput {
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly decisionId: string;
  readonly userId: string;
  /** Sentido de la decisión del usuario. */
  readonly decision: 'APPROVED' | 'REJECTED';
  /** Motivo codificado de la decisión. */
  readonly reasonCode: RecommendationFeedbackReason;
  /** Motivo en texto libre; opcional. */
  readonly reason?: string;
  /** Tipo de recomendación (instantánea para el análisis). */
  readonly recommendationType: string;
  readonly cloudAccountId: string;
  /** Severidad de la recomendación (instantánea). */
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  /** Resumen de la evidencia que respaldaba la recomendación. */
  readonly evidenceSummary: string;
}

/**
 * Datos de entrada para completar (cerrar) un evento de aprendizaje.
 *
 * Recoge el veredicto de la auditoría de IA que valida si el aprendizaje es fiable.
 */
export interface CompleteAgentLearningEventInput {
  readonly eventId: string;
  /** Estado final del evento de aprendizaje. */
  readonly status: AgentLearningStatus;
  /** Veredicto de la auditoría de IA; opcional. */
  readonly auditVerdict?: string;
  /** Puntuación de la auditoría de IA; opcional. */
  readonly auditScore?: number;
  /** Informe detallado de la auditoría; opcional. */
  readonly auditReport?: unknown;
  /** Mensaje de error si el evento terminó en fallo; opcional. */
  readonly errorMessage?: string;
}

/**
 * Datos de entrada para crear una memoria del agente.
 *
 * Una memoria es conocimiento consolidado y auditado, derivado de uno o más
 * eventos de aprendizaje, que condiciona el comportamiento futuro del agente.
 */
export interface CreateAgentMemoryInput {
  /** Tenant propietario; ausente cuando la memoria es de alcance global. */
  readonly tenantId?: string;
  /** Alcance de la memoria (global o por tenant). */
  readonly scope: AgentMemoryScope;
  /** Tipo de memoria (e.g., preferencia, restricción). */
  readonly memoryType: AgentMemoryType;
  readonly content: string;
  /** Nivel de confianza asociado a la memoria. */
  readonly confidence: number;
  /** Evento de aprendizaje que originó esta memoria. */
  readonly sourceLearningEventId: string;
  readonly metadata: unknown;
  /** Veredicto de la auditoría de IA que validó la memoria. */
  readonly auditVerdict: string;
  /** Puntuación de la auditoría de IA. */
  readonly auditScore: number;
  readonly auditReport: unknown;
  /** Huella única para deduplicar memorias equivalentes. */
  readonly fingerprint: string;
}

/**
 * Vista mínima de un evento de aprendizaje encolado pendiente de procesar.
 */
export interface QueuedAgentLearningEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly decisionId: string;
  readonly userId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly reasonCode: RecommendationFeedbackReason;
  readonly reason?: string;
  /** Intento actual, incrementado al reclamar el evento. */
  readonly attempts: number;
  /** Máximo de intentos antes de omitir un fallo externo. */
  readonly maxAttempts: number;
}

/**
 * Conteo de patrones de aprendizaje similares.
 *
 * Permite valorar la prevalencia de un patrón antes de promover una memoria
 * (e.g., de alcance de tenant a global).
 */
export interface SimilarLearningPatternCount {
  /** Número de eventos similares encontrados. */
  readonly eventCount: number;
  /** Número de tenants distintos en los que aparece el patrón. */
  readonly tenantCount: number;
}

/**
 * Contrato de repositorio de aprendizaje del agente.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en la capa de
 * infraestructura. Persiste eventos de aprendizaje y memorias, y provee consultas
 * de contexto y de patrones que sustentan el ciclo de aprendizaje del agente.
 */
export interface IAgentLearningRepository {
  /**
   * Crea un evento de aprendizaje a partir de una decisión.
   *
   * @param input - Instantánea de la recomendación y del feedback.
   * @returns El evento de aprendizaje creado.
   */
  createEvent(input: CreateAgentLearningEventInput): Promise<AgentLearningEvent>;

  /**
   * Busca un evento de aprendizaje encolado por su identificador.
   *
   * @param eventId - Identificador del evento.
   * @returns La vista del evento encolado; `null` si no existe o no está encolado.
   */
  findQueuedEventById(eventId: string): Promise<QueuedAgentLearningEvent | null>;

  /** Reclama atómicamente el siguiente evento disponible para un worker. */
  claimNextQueuedEvent(input: {
    readonly workerId: string;
    readonly leaseExpiredBefore: Date;
  }): Promise<QueuedAgentLearningEvent | null>;

  /** Libera un evento externo fallido para reintento o lo omite al agotar intentos. */
  releaseEventForRetry(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date;
  }): Promise<AgentLearningStatus>;

  /**
   * Marca un evento de aprendizaje como completado con su veredicto de auditoría.
   *
   * @param input - Estado final y resultados de la auditoría.
   * @returns El evento de aprendizaje actualizado.
   */
  completeEvent(input: CompleteAgentLearningEventInput): Promise<AgentLearningEvent>;

  /**
   * Crea una memoria del agente derivada de un evento de aprendizaje auditado.
   *
   * @param input - Datos de la memoria a crear.
   * @returns La memoria creada.
   */
  createMemory(input: CreateAgentMemoryInput): Promise<AgentMemory>;

  /**
   * Recupera el contexto de aprendizaje relevante a una recomendación.
   *
   * @param input - Tenant, texto de consulta y límite de resultados.
   * @returns Contexto de aprendizaje con referencias a memorias, casos y resumen.
   */
  findRecommendationLearningContext(input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  }): Promise<AgentLearningContext>;

  /**
   * Obtiene el resumen de aprendizaje de un tenant.
   *
   * @param tenantId - Tenant cuyo resumen se solicita.
   * @returns Resumen con memorias y eventos de aprendizaje.
   */
  findSummary(tenantId: string): Promise<AgentLearningSummary>;

  /**
   * Cuenta eventos similares con la misma decisión, motivo y tipo de recomendación.
   *
   * @param input - Motivo codificado, tipo de recomendación y sentido de la decisión.
   * @returns Conteo de eventos y de tenants en los que aparece el patrón.
   */
  countSimilarApprovedEvents(input: {
    readonly reasonCode: RecommendationFeedbackReason;
    readonly recommendationType: string;
    readonly decision: 'APPROVED' | 'REJECTED';
  }): Promise<SimilarLearningPatternCount>;

  /**
   * Indica si existe una memoria global activa con la huella indicada.
   *
   * @param fingerprint - Huella de deduplicación de la memoria.
   * @returns `true` si ya existe una memoria global activa equivalente; `false` en caso contrario.
   */
  hasActiveGlobalMemory(fingerprint: string): Promise<boolean>;
}

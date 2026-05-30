/**
 * Motivo asociado a la decisión (aprobación o rechazo) de una recomendación.
 * Alimenta el aprendizaje del agente para detectar patrones de decisión.
 *
 * - `APPROVED_HIGH_CONFIDENCE`: Aprobada por alta confianza en la evidencia.
 * - `APPROVED_LOW_RISK_QUICK_WIN`: Aprobada por ser una mejora rápida de bajo riesgo.
 * - `REJECTED_INSUFFICIENT_EVIDENCE`: Rechazada por evidencia insuficiente.
 * - `REJECTED_SAVINGS_UNREALISTIC`: Rechazada por ahorro estimado poco realista.
 * - `REJECTED_OPERATIONAL_RISK`: Rechazada por riesgo operativo.
 * - `REJECTED_BUSINESS_EXCEPTION`: Rechazada por una excepción de negocio.
 * - `REJECTED_ALREADY_HANDLED`: Rechazada porque ya fue atendida por otra vía.
 * - `REJECTED_WRONG_SCOPE`: Rechazada por aplicarse a un ámbito incorrecto.
 * - `REJECTED_NOT_ACTIONABLE`: Rechazada por no ser accionable.
 */
export type RecommendationFeedbackReason =
  | 'APPROVED_HIGH_CONFIDENCE'
  | 'APPROVED_LOW_RISK_QUICK_WIN'
  | 'REJECTED_INSUFFICIENT_EVIDENCE'
  | 'REJECTED_SAVINGS_UNREALISTIC'
  | 'REJECTED_OPERATIONAL_RISK'
  | 'REJECTED_BUSINESS_EXCEPTION'
  | 'REJECTED_ALREADY_HANDLED'
  | 'REJECTED_WRONG_SCOPE'
  | 'REJECTED_NOT_ACTIONABLE';

/**
 * Estado de procesamiento de un evento de aprendizaje del agente.
 *
 * - `PENDING`: Pendiente de procesar.
 * - `APPROVED`: Decisión de aprobación registrada.
 * - `REJECTED`: Decisión de rechazo registrada.
 * - `SKIPPED`: Omitido (no relevante para el aprendizaje).
 * - `ERROR`: Falló el procesamiento del evento.
 */
export type AgentLearningStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED' | 'ERROR';

/**
 * Alcance de una entrada de memoria del agente.
 *
 * - `LOCAL`: Memoria acotada a un único tenant.
 * - `GLOBAL`: Memoria compartida entre todos los tenants.
 */
export type AgentMemoryScope = 'LOCAL' | 'GLOBAL';

/**
 * Tipo de conocimiento almacenado en la memoria del agente.
 *
 * - `RULE`: Regla derivada del aprendizaje.
 * - `LESSON`: Lección aprendida de decisiones previas.
 * - `APPROVAL_PATTERN`: Patrón recurrente de aprobaciones.
 * - `REJECTION_PATTERN`: Patrón recurrente de rechazos.
 * - `DECISION_PATTERN`: Patrón general de decisión.
 */
export type AgentMemoryType =
  | 'RULE'
  | 'LESSON'
  | 'APPROVAL_PATTERN'
  | 'REJECTION_PATTERN'
  | 'DECISION_PATTERN';

/**
 * Evento de aprendizaje generado a partir de la decisión humana sobre una
 * recomendación. Es la materia prima del proceso de aprendizaje del agente.
 */
export interface AgentLearningEvent {
  /** Identificador único del evento. */
  readonly id: string;
  /** Tenant (cliente) al que pertenece el evento. */
  readonly tenantId: string;
  /** Recomendación sobre la que se tomó la decisión. */
  readonly recommendationId: string;
  /** Decisión (aprobación/rechazo) que originó el evento. */
  readonly decisionId: string;
  /** Estado de procesamiento del evento de aprendizaje. */
  readonly status: AgentLearningStatus;
  /** Veredicto de la auditoría de IA asociada, si la hubo. */
  readonly auditVerdict?: string;
  /** Puntuación de la auditoría de IA asociada, si la hubo. */
  readonly auditScore?: number;
  /** Fecha de creación del evento. */
  readonly createdAt: Date;
}

/**
 * Entrada de memoria del agente: conocimiento consolidado (reglas, lecciones o
 * patrones) que el agente reutiliza en futuras operaciones.
 */
export interface AgentMemory {
  /** Identificador único de la entrada de memoria. */
  readonly id: string;
  /** Tenant propietario cuando el alcance es `LOCAL`; ausente para memoria `GLOBAL`. */
  readonly tenantId?: string;
  /** Alcance de la memoria (local al tenant o global). */
  readonly scope: AgentMemoryScope;
  /** Tipo de conocimiento almacenado. */
  readonly memoryType: AgentMemoryType;
  /** Contenido del conocimiento, en lenguaje natural. */
  readonly content: string;
  /** Confianza en el conocimiento, normalmente en el rango [0, 1]. */
  readonly confidence: number;
  /** `true` si la entrada está activa y debe considerarse al construir el contexto. */
  readonly active: boolean;
  /** Fecha de creación de la entrada. */
  readonly createdAt: Date;
}

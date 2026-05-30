import type { FinOpsRecommendation } from '../models/FinOpsRecommendation.js';
import type { RecommendationFeedbackReason } from '../models/AgentLearning.js';
import type {
  AiAuditReport,
  AiAuditVerdict,
  RecommendationExecutionPlan,
} from '../models/RecommendationExecutionPlan.js';

/**
 * Criterios de consulta para listar recomendaciones de un tenant.
 */
export interface RecommendationQuery {
  readonly tenantId: string;
  /** Filtra por cuenta cloud; opcional. */
  readonly cloudAccountId?: string;
  /** Filtra por estado de la recomendación; opcional. */
  readonly status?: FinOpsRecommendation['status'];
}

/**
 * Datos de entrada para crear una recomendación FinOps.
 */
export interface CreateRecommendationInput {
  readonly tenantId: string;
  readonly cloudAccountId: string;
  /** Tipo de recomendación (e.g., rightsizing, eliminación de recursos ociosos). */
  readonly type: string;
  /** Severidad/prioridad de la recomendación. */
  readonly severity: FinOpsRecommendation['severity'];
  readonly title: string;
  readonly description: string;
  /** Evidencia estructurada que respalda la recomendación. */
  readonly evidence: unknown;
  /** Ahorro mensual estimado; opcional cuando no puede cuantificarse. */
  readonly estimatedMonthlySavings?: number;
  /** Código de moneda de los importes. */
  readonly currency: string;
}

/**
 * Datos de entrada para crear un plan de ejecución generado por IA para una recomendación.
 *
 * Incluye tanto el contenido del plan como el resultado de su auditoría automática.
 */
export interface CreateRecommendationExecutionPlanInput {
  readonly recommendationId: string;
  readonly generatedByUserId: string;
  /** Modelo de IA que generó el plan. */
  readonly model: string;
  /** Modelo de IA que auditó el plan. */
  readonly auditorModel: string;
  /** Contenido estructurado del plan de ejecución. */
  readonly content: unknown;
  /** Informe detallado de la auditoría del plan. */
  readonly auditReport: AiAuditReport;
  /** Veredicto de la auditoría del plan. */
  readonly auditVerdict: AiAuditVerdict;
  /** Puntuación de la auditoría del plan. */
  readonly auditScore: number;
}

/**
 * Datos de entrada para registrar la decisión de un usuario sobre una recomendación.
 */
export interface CreateRecommendationDecisionInput {
  readonly tenantId: string;
  readonly recommendationId: string;
  /** Plan de ejecución asociado a la decisión; opcional. */
  readonly executionPlanId?: string;
  readonly userId: string;
  /** Sentido de la decisión: aprobada, rechazada o marcada como realizada. */
  readonly decision: 'APPROVED' | 'REJECTED' | 'MARKED_DONE';
  /** Motivo codificado de la decisión; opcional. */
  readonly reasonCode?: RecommendationFeedbackReason;
  /** Motivo en texto libre; opcional. */
  readonly reason?: string;
}

/**
 * Resultado de registrar una decisión sobre una recomendación.
 */
export interface CreateRecommendationDecisionResult {
  /** Identificador de la decisión registrada. */
  readonly decisionId: string;
  /** Recomendación con su estado ya actualizado tras la decisión. */
  readonly recommendation: FinOpsRecommendation;
}

/** Estado de una ejecución manual de una recomendación. */
export type ManualExecutionStatus = 'PLANNED' | 'EXECUTED' | 'PARTIAL' | 'CANCELLED';

/**
 * Registro de la ejecución manual de una recomendación por parte de un usuario.
 *
 * Permite contrastar el ahorro estimado con el ahorro realmente observado.
 */
export interface RecommendationManualExecution {
  readonly id: string;
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly executionPlanId?: string;
  readonly userId: string;
  readonly status: ManualExecutionStatus;
  /** Instante en que se ejecutó; opcional mientras está planificada. */
  readonly executedAt?: Date;
  /** Ahorro mensual realmente observado tras la ejecución; opcional. */
  readonly observedMonthlySavings?: number;
  readonly currency: string;
  readonly notes?: string;
  readonly evidence?: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Datos de entrada para registrar la ejecución manual de una recomendación.
 */
export interface CreateManualExecutionInput {
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly executionPlanId?: string;
  readonly userId: string;
  readonly status: ManualExecutionStatus;
  readonly executedAt?: Date;
  /** Ahorro mensual observado tras la ejecución; opcional. */
  readonly observedMonthlySavings?: number;
  readonly currency: string;
  readonly notes?: string;
  readonly evidence?: unknown;
}

/**
 * Evento de la línea de tiempo del ciclo de vida de una recomendación.
 *
 * Unifica en una sola cronología los hitos de creación, planificación,
 * decisión, ejecución y aprendizaje.
 */
export interface RecommendationTimelineEvent {
  readonly id: string;
  /** Tipo de hito representado en la línea de tiempo. */
  readonly type: 'RECOMMENDATION_CREATED' | 'PLAN_GENERATED' | 'DECISION_RECORDED' | 'MANUAL_EXECUTION_RECORDED' | 'LEARNING_EVENT';
  readonly title: string;
  readonly description: string;
  readonly createdAt: Date;
  readonly metadata?: unknown;
}

/**
 * Indicadores (KPIs) de ahorro derivados de las recomendaciones de un tenant.
 */
export interface SavingsKpis {
  /** Ahorro mensual estimado agregado de las recomendaciones. */
  readonly estimatedMonthlySavings: number;
  /** Ahorro mensual observado agregado tras ejecuciones. */
  readonly observedMonthlySavings: number;
  /** Ahorro mensual confirmado agregado. */
  readonly confirmedMonthlySavings: number;
  /** Ahorro perdido agregado por recomendaciones no ejecutadas a tiempo. */
  readonly missedSavingsAmount: number;
  readonly currency: string;
  /** Número de recomendaciones ejecutadas. */
  readonly executedRecommendations: number;
  /** Número de recomendaciones con ahorro aún pendiente de materializar. */
  readonly pendingSavingsRecommendations: number;
  /** Recomendación con mayor ahorro perdido; ausente si no aplica. */
  readonly topMissedSavingsRecommendation?: {
    readonly id: string;
    readonly title: string;
    readonly missedSavingsAmount: number;
    readonly estimatedMonthlySavings: number;
    readonly currency: string;
    readonly createdAt: Date;
    readonly status: FinOpsRecommendation['status'];
  };
}

/**
 * Indicadores (KPIs) de adopción de las recomendaciones de un tenant.
 */
export interface AdoptionKpis {
  readonly totalRecommendations: number;
  readonly pendingRecommendations: number;
  readonly approvedRecommendations: number;
  readonly rejectedRecommendations: number;
  readonly completedRecommendations: number;
  /** Proporción de recomendaciones aceptadas (0–1). */
  readonly acceptanceRate: number;
  /** Proporción de recomendaciones rechazadas (0–1). */
  readonly rejectionRate: number;
  /** Proporción de recomendaciones ejecutadas (0–1). */
  readonly executionRate: number;
}

/**
 * Contrato de repositorio de recomendaciones FinOps.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en la capa de
 * infraestructura. Gestiona el ciclo de vida completo de las recomendaciones:
 * creación, planes de ejecución generados por IA, decisiones, ejecuciones
 * manuales, línea de tiempo y KPIs de ahorro y adopción.
 */
export interface IRecommendationRepository {
  /**
   * Lista las recomendaciones de un tenant según los criterios indicados.
   *
   * @param query - Tenant y filtros opcionales (cuenta, estado).
   * @returns Recomendaciones que cumplen los criterios.
   */
  findByTenant(query: RecommendationQuery): Promise<FinOpsRecommendation[]>;

  /**
   * Busca una recomendación por su identificador dentro de un tenant.
   *
   * @param tenantId         - Tenant propietario.
   * @param recommendationId - Identificador de la recomendación.
   * @returns La recomendación si existe; `null` si no se encuentra o no pertenece al tenant.
   */
  findById(tenantId: string, recommendationId: string): Promise<FinOpsRecommendation | null>;

  /**
   * Crea múltiples recomendaciones en lote.
   *
   * @param input - Conjunto de recomendaciones a crear.
   * @returns Las recomendaciones creadas.
   */
  createMany(input: readonly CreateRecommendationInput[]): Promise<FinOpsRecommendation[]>;

  /**
   * Crea un plan de ejecución (generado y auditado por IA) para una recomendación.
   *
   * @param input - Contenido del plan y resultados de su auditoría.
   * @returns El plan de ejecución creado.
   */
  createExecutionPlan(input: CreateRecommendationExecutionPlanInput): Promise<RecommendationExecutionPlan>;

  /**
   * Busca un plan de ejecución por su identificador dentro de un tenant.
   *
   * @param tenantId        - Tenant propietario.
   * @param executionPlanId - Identificador del plan.
   * @returns El plan si existe; `null` si no se encuentra.
   */
  findExecutionPlanById(
    tenantId: string,
    executionPlanId: string,
  ): Promise<RecommendationExecutionPlan | null>;

  /**
   * Obtiene el último plan de ejecución generado para una recomendación.
   *
   * @param tenantId         - Tenant propietario.
   * @param recommendationId - Identificador de la recomendación.
   * @returns El plan más reciente; `null` si la recomendación aún no tiene planes.
   */
  findLatestExecutionPlanByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationExecutionPlan | null>;

  /**
   * Registra una decisión sobre una recomendación y actualiza su estado.
   *
   * @param input - Datos de la decisión.
   * @returns Identificador de la decisión y la recomendación actualizada.
   */
  createDecision(input: CreateRecommendationDecisionInput): Promise<CreateRecommendationDecisionResult>;

  /**
   * Registra la ejecución manual de una recomendación.
   *
   * @param input - Datos de la ejecución manual.
   * @returns El registro de ejecución manual creado.
   */
  createManualExecution(input: CreateManualExecutionInput): Promise<RecommendationManualExecution>;

  /**
   * Lista las ejecuciones manuales asociadas a una recomendación.
   *
   * @param tenantId         - Tenant propietario.
   * @param recommendationId - Identificador de la recomendación.
   * @returns Ejecuciones manuales registradas (posiblemente vacío).
   */
  findManualExecutionsByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationManualExecution[]>;

  /**
   * Obtiene la línea de tiempo de eventos de una recomendación.
   *
   * @param tenantId         - Tenant propietario.
   * @param recommendationId - Identificador de la recomendación.
   * @returns Eventos cronológicos de la recomendación.
   */
  findTimelineByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationTimelineEvent[]>;

  /**
   * Calcula los KPIs de ahorro de un tenant.
   *
   * @param tenantId - Tenant a evaluar.
   * @returns Indicadores de ahorro agregados.
   */
  getSavingsKpis(tenantId: string): Promise<SavingsKpis>;

  /**
   * Calcula los KPIs de adopción de un tenant.
   *
   * @param tenantId - Tenant a evaluar.
   * @returns Indicadores de adopción agregados.
   */
  getAdoptionKpis(tenantId: string): Promise<AdoptionKpis>;
}

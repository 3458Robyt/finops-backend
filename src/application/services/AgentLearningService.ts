import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IAiGateway } from '../../domain/interfaces/IAiGateway.js';
import type {
  IAgentLearningRepository,
  QueuedAgentLearningEvent,
} from '../../domain/interfaces/IAgentLearningRepository.js';
import type {
  AgentLearningContext,
  AgentLearningContextQuery,
  AgentLearningSummary,
  IAgentLearningService,
  ProcessRecommendationDecisionInput,
  RecommendationLearningResult,
} from '../../domain/interfaces/IAgentLearningService.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import { ContextBudgeter } from './ContextBudgeter.js';
import { summarizeEvidence } from './learning/learningMemoryContent.js';
import { LearningEventProcessor } from './learning/LearningEventProcessor.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import { loadRuntimeConfig } from '../../infrastructure/config/runtimeConfigReader.js';
import type { RuntimeConfig } from '../../infrastructure/config/runtimeConfigTypes.js';

interface AgentLearningRuntimeOptions {
  readonly auditorModel: string;
  readonly learningAuditTimeoutMs: number;
  readonly learningLeaseMs: number;
}

/**
 * Servicio de aprendizaje del agente IA FinOps.
 *
 * Responsabilidad: convertir las decisiones humanas sobre recomendaciones
 * (aprobación/rechazo + motivo) en "memorias" reutilizables que orientan al
 * agente en el futuro. Cada memoria candidata es auditada por un modelo IA
 * independiente antes de persistirse, y los patrones recurrentes pueden
 * promoverse a memoria GLOBAL compartida entre tenants.
 *
 * Actúa como coordinador del caso de uso: delega la construcción de contenido
 * de memorias en `learning/learningMemoryContent` y el parseo/clasificación de
 * la auditoría IA en `learning/learningAuditParser`, ambos módulos de funciones
 * puras a los que inyecta el truncado del {@link ContextBudgeter}.
 *
 * Colaboradores inyectados (DIP):
 * - {@link IRecommendationRepository}: lectura de la recomendación evaluada.
 * - {@link IAgentLearningRepository}: persistencia de eventos, memorias y métricas de aprendizaje.
 * - {@link IAiGateway}: auditoría IA del candidato de memoria.
 * - {@link ContextBudgeter}: truncado/compactación de texto para limitar tokens.
 */
export class AgentLearningService implements IAgentLearningService {
  /** Modelo IA usado como auditor de aprendizaje (resuelto en el constructor). */
  private readonly auditorModel: string;
  private readonly eventProcessor: LearningEventProcessor;
  private readonly learningWorkerLeaseMs: number;

  /**
   * @param recommendationRepository - Repositorio de recomendaciones.
   * @param learningRepository       - Repositorio de eventos/memorias de aprendizaje.
   * @param aiGateway                - Pasarela hacia el proveedor IA.
   * @param contextBudgeter          - Utilidad de presupuesto de contexto (truncado).
   *
   * El modelo auditor se toma de `AI_AUDITOR_MODEL`, o del modelo del
   * gateway, o de un valor por defecto, en ese orden de prioridad.
   */
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly learningRepository: IAgentLearningRepository,
    private readonly aiGateway: IAiGateway,
    private readonly contextBudgeter = new ContextBudgeter(),
    runtimeOptions: AgentLearningRuntimeOptions = defaultRuntimeOptions(),
  ) {
    this.auditorModel = runtimeOptions.auditorModel || aiGateway.modelName || 'gpt-5.4-mini';
    this.learningWorkerLeaseMs = runtimeOptions.learningLeaseMs;
    this.eventProcessor = new LearningEventProcessor({
      recommendationRepository,
      learningRepository,
      aiGateway,
      auditorModel: this.auditorModel,
      learningAuditTimeoutMs: runtimeOptions.learningAuditTimeoutMs,
      truncate: (value, maxChars) => this.contextBudgeter.truncate(value, maxChars),
    });
  }

  /** Función de truncado del budgeter, inyectada a las funciones puras de contenido. */
  private get truncate(): (value: string, maxChars: number) => string {
    return (value, maxChars) => this.contextBudgeter.truncate(value, maxChars);
  }

  /**
   * Procesa de extremo a extremo una decisión sobre una recomendación:
   * encola el evento de aprendizaje y, si se creó, lo procesa de inmediato.
   *
   * Efectos secundarios: **persiste** el evento y, según el resultado de la
   * auditoría, persiste o no la memoria asociada.
   *
   * @param input - Decisión humana (recomendación, decisión, motivo, actor).
   * @returns Resultado del aprendizaje (estado y, si aplica, eventId/error).
   *
   * @throws {FinOpsBaseError} Con código `NOT_FOUND` si la recomendación no existe.
   */
  public async processRecommendationDecision(
    input: ProcessRecommendationDecisionInput,
  ): Promise<RecommendationLearningResult> {
    const queued = await this.queueRecommendationDecision(input);

    if (queued.eventId === undefined) {
      return queued;
    }

    return this.processQueuedRecommendationDecision(queued.eventId);
  }

  /**
   * Encola una decisión de recomendación como evento de aprendizaje PENDING.
   *
   * Efectos secundarios: **persiste** un nuevo evento de aprendizaje con un
   * resumen de la evidencia de la recomendación. No invoca aún al modelo IA.
   *
   * @param input - Decisión humana sobre la recomendación.
   * @returns Resultado con estado `PENDING` y el `eventId` creado.
   *
   * @throws {FinOpsBaseError} Con código `NOT_FOUND` si la recomendación no existe.
   */
  public async queueRecommendationDecision(
    input: ProcessRecommendationDecisionInput,
  ): Promise<RecommendationLearningResult> {
    const recommendation = await this.recommendationRepository.findById(
      input.tenantId,
      input.recommendationId,
    );

    if (recommendation === null) {
      throw new FinOpsBaseError('Recommendation not found for learning', 'NOT_FOUND');
    }

    const event = await this.learningRepository.createEvent({
      tenantId: input.tenantId,
      recommendationId: input.recommendationId,
      decisionId: input.decisionId,
      userId: input.userId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      recommendationType: recommendation.type,
      cloudAccountId: recommendation.cloudAccountId,
      severity: recommendation.severity,
      title: recommendation.title,
      description: recommendation.description,
      evidenceSummary: summarizeEvidence(recommendation.evidence, this.truncate),
    });

    return {
      status: 'PENDING',
      eventId: event.id,
    };
  }

  /**
   * Procesa un evento de aprendizaje previamente encolado.
   *
   * Flujo y heurística:
   * 1. Recupera el evento y la recomendación asociada.
   * 2. Construye un candidato de memoria y lo somete a auditoría IA.
   * 3. Aprueba solo si el veredicto es `APPROVED` y el score ≥ 80; en otro
   *    caso marca el evento como `REJECTED`.
   * 4. Si se aprueba, **persiste** la memoria LOCAL (confianza acotada al
   *    rango 0.7–0.95) e intenta promover un patrón GLOBAL.
   * 5. Distingue fallos externos de IA (timeout, rate limit, JSON inválido,
   *    etc.) marcándolos como `SKIPPED` en vez de `ERROR`.
   *
   * Efectos secundarios: múltiples escrituras en el repositorio de aprendizaje
   * y una llamada al modelo IA auditor.
   *
   * @param eventId - Identificador del evento encolado.
   * @returns Resultado con el estado final (`APPROVED`, `REJECTED`, `SKIPPED` o `ERROR`).
   *
   * @throws {FinOpsBaseError} Con código `NOT_FOUND` si el evento encolado no existe.
   */
  public async processQueuedRecommendationDecision(eventId: string): Promise<RecommendationLearningResult> {
    const event = await this.learningRepository.findQueuedEventById(eventId);

    if (event === null) {
      throw new FinOpsBaseError('Queued learning event not found', 'NOT_FOUND');
    }

    return this.processEvent(event);
  }

  /** Reclama y procesa un único evento disponible para el worker persistente. */
  public async processNextQueuedRecommendationDecision(workerId: string): Promise<RecommendationLearningResult | null> {
    return runWithDatabaseContext({ workerId, role: 'MASTER_ADMIN' }, async () => {
      const event = await this.learningRepository.claimNextQueuedEvent({
        workerId,
        leaseExpiredBefore: new Date(Date.now() - this.learningWorkerLeaseMs),
      });
      if (event === null) {
        return null;
      }

      return runWithDatabaseContext(
        { tenantId: event.tenantId, workerId, role: 'MASTER_ADMIN' },
        () => this.processEvent(event, workerId),
      );
    });
  }

  private async processEvent(
    event: QueuedAgentLearningEvent,
    workerId?: string,
  ): Promise<RecommendationLearningResult> {
    return this.eventProcessor.process(event, workerId);
  }

  /**
   * Recupera el contexto de aprendizaje relevante para una consulta de
   * generación de recomendaciones, compactado para ajustarse al presupuesto
   * de tokens.
   *
   * @param query - Tenant, texto de consulta y límite opcional (por defecto 5).
   * @returns Contexto de aprendizaje compactado (memorias y casos previos).
   */
  public async getRecommendationLearningContext(
    query: AgentLearningContextQuery,
  ): Promise<AgentLearningContext> {
    const context = await this.learningRepository.findRecommendationLearningContext({
      tenantId: query.tenantId,
      queryText: query.queryText,
      limit: query.limit ?? 5,
    });

    return this.contextBudgeter.compactLearningContext(context);
  }

  /**
   * Obtiene un resumen agregado del aprendizaje de un tenant.
   *
   * @param tenantId - Identificador del tenant.
   * @returns Resumen del estado de aprendizaje del agente para el tenant.
   */
  public async getLearningSummary(tenantId: string): Promise<AgentLearningSummary> {
    return this.learningRepository.findSummary(tenantId);
  }

}

function defaultRuntimeOptions(): AgentLearningRuntimeOptions {
  const config: RuntimeConfig = loadRuntimeConfig();
  return {
    auditorModel: config.ai.auditorModel,
    learningAuditTimeoutMs: config.ai.learningAuditTimeoutMs,
    learningLeaseMs: config.workers.learning.leaseMs,
  };
}

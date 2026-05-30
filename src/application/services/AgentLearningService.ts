import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IAiGateway } from '../../domain/interfaces/IAiGateway.js';
import type { IAgentLearningRepository } from '../../domain/interfaces/IAgentLearningRepository.js';
import type {
  AgentLearningContext,
  AgentLearningContextQuery,
  AgentLearningSummary,
  IAgentLearningService,
  ProcessRecommendationDecisionInput,
  RecommendationLearningResult,
} from '../../domain/interfaces/IAgentLearningService.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { AiAuditReport } from '../../domain/models/RecommendationExecutionPlan.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import { ContextBudgeter } from './ContextBudgeter.js';
import {
  buildMemoryCandidate,
  summarizeEvidence,
  type MemoryCandidate,
} from './learning/learningMemoryContent.js';
import {
  isExternalAiLearningFailure,
  parseAuditReport,
} from './learning/learningAuditParser.js';
import { buildLearningAuditRequest } from './learning/learningAuditPrompt.js';
import {
  buildGlobalMemoryInput,
  buildLocalMemoryInput,
} from './learning/memoryInputBuilder.js';

/** Veredicto del auditor IA que habilita la persistencia de una memoria aprendida. */
const approvedAuditVerdict = 'APPROVED';
/**
 * Tiempo máximo (ms) para la llamada de auditoría IA del candidato de aprendizaje.
 * Configurable vía `LEARNING_AUDIT_TIMEOUT_MS`; por defecto 15000 ms.
 */
const learningAuditTimeoutMs = Number.parseInt(process.env['LEARNING_AUDIT_TIMEOUT_MS'] ?? '15000', 10);

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

  /**
   * @param recommendationRepository - Repositorio de recomendaciones.
   * @param learningRepository       - Repositorio de eventos/memorias de aprendizaje.
   * @param aiGateway                - Pasarela hacia el proveedor IA.
   * @param contextBudgeter          - Utilidad de presupuesto de contexto (truncado).
   *
   * El modelo auditor se toma de `NVIDIA_AUDITOR_MODEL`, o del modelo del
   * gateway, o de un valor por defecto, en ese orden de prioridad.
   */
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly learningRepository: IAgentLearningRepository,
    private readonly aiGateway: IAiGateway,
    private readonly contextBudgeter = new ContextBudgeter(),
  ) {
    this.auditorModel = process.env['NVIDIA_AUDITOR_MODEL'] ?? aiGateway.modelName ?? 'deepseek-ai/deepseek-v4-flash';
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

    const recommendation = await this.recommendationRepository.findById(
      event.tenantId,
      event.recommendationId,
    );

    if (recommendation === null) {
      await this.learningRepository.completeEvent({
        eventId,
        status: 'ERROR',
        errorMessage: 'Recommendation not found for queued learning',
      });

      return {
        status: 'ERROR',
        eventId,
        error: 'Recommendation not found for queued learning',
      };
    }

    try {
      const candidate = buildMemoryCandidate(event, recommendation, this.truncate);
      const auditRequest = buildLearningAuditRequest(candidate, {
        model: this.auditorModel,
        timeoutMs: learningAuditTimeoutMs,
      });
      const auditReport = parseAuditReport(await this.aiGateway.generateText(auditRequest));

      if (auditReport.verdict !== approvedAuditVerdict || auditReport.score < 80) {
        await this.learningRepository.completeEvent({
          eventId: event.id,
          status: 'REJECTED',
          auditVerdict: auditReport.verdict,
          auditScore: auditReport.score,
          auditReport,
          errorMessage: auditReport.blockingIssues.join('\n') || 'Learning candidate rejected by auditor',
        });

        return {
          status: 'REJECTED',
          eventId: event.id,
        };
      }

      await this.learningRepository.createMemory(
        buildLocalMemoryInput(event.tenantId, event.id, candidate, auditReport),
      );

      await this.promoteGlobalPatternIfEligible(event, recommendation, candidate, auditReport, event.id);

      await this.learningRepository.completeEvent({
        eventId: event.id,
        status: 'APPROVED',
        auditVerdict: auditReport.verdict,
        auditScore: auditReport.score,
        auditReport,
      });

      return {
        status: 'APPROVED',
        eventId: event.id,
      };
    } catch (error: unknown) {
      const status = isExternalAiLearningFailure(error) ? 'SKIPPED' : 'ERROR';
      const errorMessage = error instanceof Error ? error.message : 'Learning processing failed';

      await this.learningRepository.completeEvent({
        eventId: event.id,
        status,
        errorMessage,
      });

      return {
        status,
        eventId: event.id,
        error: errorMessage,
      };
    }
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

  /**
   * Promueve el patrón aprendido a una memoria GLOBAL si cumple los umbrales
   * de madurez, para compartirlo entre tenants.
   *
   * Criterios de elegibilidad (todos obligatorios):
   * - Score de auditoría ≥ 90 (calidad alta).
   * - Al menos 5 eventos aprobados similares (mismo motivo/tipo/decisión).
   * - Presentes en al menos 2 tenants distintos (evita sesgo de un solo cliente).
   * - No existe ya una memoria GLOBAL activa con el mismo fingerprint.
   *
   * Efectos secundarios: **persiste** una memoria de ámbito GLOBAL cuando
   * todos los criterios se cumplen; en caso contrario no hace nada.
   */
  private async promoteGlobalPatternIfEligible(
    input: ProcessRecommendationDecisionInput,
    recommendation: FinOpsRecommendation,
    candidate: MemoryCandidate,
    auditReport: AiAuditReport,
    eventId: string,
  ): Promise<void> {
    if (auditReport.score < 90) {
      return;
    }

    const count = await this.learningRepository.countSimilarApprovedEvents({
      reasonCode: input.reasonCode,
      recommendationType: recommendation.type,
      decision: input.decision,
    });

    if (count.eventCount < 5 || count.tenantCount < 2) {
      return;
    }

    const globalFingerprint = `GLOBAL:${candidate.fingerprint}`;
    const exists = await this.learningRepository.hasActiveGlobalMemory(globalFingerprint);

    if (exists) {
      return;
    }

    await this.learningRepository.createMemory(
      buildGlobalMemoryInput(input, recommendation, candidate, auditReport, eventId, count, this.truncate),
    );
  }
}

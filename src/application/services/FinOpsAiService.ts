import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IAiGateway } from '../../domain/interfaces/IAiGateway.js';
import type { ICostAnalyticsRepository } from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { IAgentLearningContextProvider } from '../../domain/interfaces/IAgentLearningService.js';
import type { BuiltAiContext, IContextEngineService } from '../../domain/interfaces/IContextEngineService.js';
import type { RecommendationExecutionPlan } from '../../domain/models/RecommendationExecutionPlan.js';
import type { AiContextOperation } from '../../domain/models/AgentContext.js';
import type { AiObservabilityService } from './AiObservabilityService.js';
import { normalizeHistory } from './ai/finOpsAiPrompts.js';
import { toEphemeralRecommendation } from './ai/finOpsAiResponseParser.js';
import { applyAuditEvidence } from './ai/recommendationEvidence.js';
import { FinOpsContextAssembler } from './ai/finOpsContextAssembler.js';
import { AiTraceRecorder } from './ai/aiTraceRecorder.js';
import { FinOpsArtifactGenerator } from './ai/finOpsArtifactGenerator.js';

// Reexporta los contratos públicos para preservar la API del servicio.
export type {
  AiChatInput,
  AiChatMessage,
  AiChatResponse,
  GenerateAiRecommendationsInput,
  GenerateAiRecommendationsResponse,
  GenerateExecutionPlanInput,
} from './ai/finOpsAiTypes.js';

import type {
  AiChatInput,
  AiChatResponse,
  GenerateAiRecommendationsInput,
  GenerateAiRecommendationsResponse,
  GenerateExecutionPlanInput,
} from './ai/finOpsAiTypes.js';

/** Veredicto de auditoría requerido para aceptar el artefacto generado por IA. */
const approvedAuditVerdict = 'APPROVED';

/**
 * Servicio de aplicación de IA FinOps.
 *
 * Responsabilidad: orquestar los tres casos de uso de IA — chat sobre costos,
 * generación de recomendaciones y generación de planes de ejecución — obteniendo
 * el snapshot factual, pidiendo el contexto y el prompt al
 * {@link FinOpsContextAssembler} y delegando la generación auditada en
 * {@link FinOpsArtifactGenerator}. Mantiene dos garantías clave:
 * 1. La única fuente factual es el snapshot FOCUS (costos y consumo facturado),
 *    nunca métricas técnicas inventadas (CPU, memoria, IOPS, throughput).
 * 2. Todo artefacto generado pasa por un auditor IA independiente antes de
 *    persistirse o devolverse.
 *
 * Colaboradores de apoyo: el ensamblado de contexto/prompt vive en
 * {@link ./ai/finOpsContextAssembler}, los prompts en {@link ./ai/finOpsAiPrompts},
 * el parsing en {@link ./ai/finOpsAiResponseParser}, la generación auditada en
 * {@link ./ai/finOpsArtifactGenerator} y las trazas en {@link ./ai/aiTraceRecorder}.
 *
 * Colaboradores inyectados (DIP):
 * - {@link ICostAnalyticsRepository}: obtiene el snapshot de costos del tenant.
 * - {@link IRecommendationRepository}: persiste recomendaciones y planes.
 * - {@link IAiGateway}: pasarela al proveedor IA (generación y auditoría).
 * - {@link IAgentLearningContextProvider} (opcional): contexto de aprendizaje auditado.
 * - {@link IContextEngineService} (opcional): ensambla contexto adicional (Context Engine).
 * - {@link AiObservabilityService} (opcional): registra trazas de cada llamada IA.
 */
export class FinOpsAiService {
  /** Modelo principal usado para generar respuestas/artefactos. */
  private readonly mainModel: string;
  /** Modelo usado como auditor independiente de los artefactos generados. */
  private readonly auditorModel: string;
  /** Registrador de trazas de observabilidad IA. */
  private readonly traceRecorder: AiTraceRecorder;
  /** Generador de artefactos IA con auditoría y revisión. */
  private readonly artifactGenerator: FinOpsArtifactGenerator;
  /** Ensamblador de contexto y prompts por caso de uso. */
  private readonly contextAssembler: FinOpsContextAssembler;

  /**
   * @param analyticsRepository      - Repositorio de analítica de costos (snapshots).
   * @param recommendationRepository - Repositorio de recomendaciones y planes de ejecución.
   * @param aiGateway                - Pasarela hacia el proveedor IA.
   * @param learningContextProvider  - Proveedor opcional de contexto de aprendizaje auditado.
   * @param contextEngine            - Motor opcional de ensamblado de contexto.
   * @param aiObservability          - Servicio opcional de observabilidad/trazas IA.
   */
  constructor(
    private readonly analyticsRepository: ICostAnalyticsRepository,
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly aiGateway: IAiGateway,
    learningContextProvider?: IAgentLearningContextProvider,
    contextEngine?: IContextEngineService,
    aiObservability?: AiObservabilityService,
  ) {
    this.mainModel = aiGateway.modelName ?? process.env['NVIDIA_MODEL'] ?? 'deepseek-ai/deepseek-v4-flash';
    this.auditorModel = process.env['NVIDIA_AUDITOR_MODEL'] ?? this.mainModel;
    this.traceRecorder = new AiTraceRecorder(aiObservability);
    this.artifactGenerator = new FinOpsArtifactGenerator(
      aiGateway,
      this.traceRecorder,
      this.mainModel,
      this.auditorModel,
    );
    this.contextAssembler = new FinOpsContextAssembler(
      this.mainModel,
      learningContextProvider,
      contextEngine,
    );
  }

  /**
   * Responde una consulta de chat sobre costos del tenant.
   *
   * Flujo: obtiene el snapshot de costos, pide al ensamblador el contexto y el
   * prompt de sistema, llama al modelo principal con temperatura baja (0.3) y
   * registra la traza de observabilidad (éxito o error).
   *
   * @param input - Tenant, mensaje y, opcionalmente, usuario e historial.
   * @returns Respuesta del asistente y el snapshot factual usado.
   *
   * @throws {FinOpsBaseError} Con código `VALIDATION_ERROR` si el mensaje está vacío.
   * @throws Propaga errores del gateway IA tras registrarlos en la traza.
   */
  public async answerChat(input: AiChatInput): Promise<AiChatResponse> {
    const message = input.message.trim();

    if (message === '') {
      throw new FinOpsBaseError('Chat message is required', 'VALIDATION_ERROR');
    }

    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const { builtContext, systemPrompt } = await this.contextAssembler.assembleChatContext({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      message,
      snapshot,
    });
    const startedAt = Date.now();

    try {
      const answer = await this.aiGateway.generateText({
        responseFormat: 'text',
        temperature: 0.3,
        maxTokens: 900,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          ...normalizeHistory(input.history),
          {
            role: 'user',
            content: message,
          },
        ],
      });

      await this.recordTrace(input, 'CHAT', builtContext, startedAt, answer);

      return {
        answer: answer.trim(),
        snapshot,
      };
    } catch (error: unknown) {
      await this.recordTrace(input, 'CHAT', builtContext, startedAt, undefined, error);
      throw error;
    }
  }

  /**
   * Genera recomendaciones FinOps priorizadas a partir del snapshot del tenant.
   *
   * Flujo: obtiene snapshot y, vía el ensamblador, el contexto de aprendizaje y
   * el prompt; delega la generación y auditoría (con una ronda de revisión) en el
   * generador de artefactos, rechaza si la auditoría no aprueba, enriquece la
   * evidencia y **persiste** solo si `persist === true` (si no, devuelve preview
   * efímero).
   *
   * @param input - Tenant, usuario opcional y bandera de persistencia.
   * @returns Recomendaciones (persistidas o preview), snapshot y flag `persisted`.
   *
   * @throws {FinOpsBaseError} `AI_RESPONSE_ERROR` si la IA no devuelve recomendaciones
   *         válidas, o `AI_AUDIT_REJECTED` si la auditoría las rechaza.
   */
  public async generateRecommendations(
    input: GenerateAiRecommendationsInput,
  ): Promise<GenerateAiRecommendationsResponse> {
    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const { builtContext, systemPrompt, learningContext } = await this.contextAssembler.assembleRecommendationContext({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      snapshot,
    });
    const startedAt = Date.now();

    const { drafts, auditReport, firstRawResponse } = await this.artifactGenerator.generateAuditedDrafts(
      input.tenantId,
      input.userId,
      snapshot,
      systemPrompt,
    );

    if (auditReport.verdict !== approvedAuditVerdict) {
      throw new FinOpsBaseError('AI audit rejected recommendation output', 'AI_AUDIT_REJECTED');
    }

    const auditedDrafts = drafts.map((draft) => applyAuditEvidence(draft, auditReport, learningContext));

    const persisted = input.persist === true;
    const recommendations = persisted
      ? await this.recommendationRepository.createMany(auditedDrafts)
      : auditedDrafts.map((draft, index) => toEphemeralRecommendation(draft, index));

    await this.recordTrace(input, 'RECOMMENDATION', builtContext, startedAt, firstRawResponse);

    return {
      recommendations,
      snapshot,
      persisted,
    };
  }

  /**
   * Genera un plan de ejecución manual y gobernado para una recomendación.
   *
   * Flujo: localiza la recomendación, obtiene snapshot y, vía el ensamblador, el
   * contexto y el prompt; delega la generación y auditoría del plan (con una
   * ronda de revisión) en el generador de artefactos y **persiste** siempre el
   * plan resultante.
   *
   * @param input - Tenant, usuario y recomendación objetivo.
   * @returns El plan de ejecución persistido.
   *
   * @throws {FinOpsBaseError} `NOT_FOUND` si la recomendación no existe, o
   *         `AI_RESPONSE_ERROR` si la IA no devuelve un plan válido/completo.
   */
  public async generateExecutionPlan(
    input: GenerateExecutionPlanInput,
  ): Promise<RecommendationExecutionPlan> {
    const recommendation = await this.recommendationRepository.findById(
      input.tenantId,
      input.recommendationId,
    );

    if (recommendation === null) {
      throw new FinOpsBaseError('Recommendation not found', 'NOT_FOUND');
    }

    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const { builtContext, systemPrompt } = await this.contextAssembler.assembleExecutionPlanContext({
      tenantId: input.tenantId,
      userId: input.userId,
      snapshot,
      recommendation,
    });
    const startedAt = Date.now();

    const { content, auditReport, firstRawResponse } = await this.artifactGenerator.generateAuditedPlan(
      input.tenantId,
      input.userId,
      snapshot,
      recommendation,
      systemPrompt,
    );

    const plan = await this.recommendationRepository.createExecutionPlan({
      recommendationId: recommendation.id,
      generatedByUserId: input.userId,
      model: this.mainModel,
      auditorModel: this.auditorModel,
      content,
      auditReport,
      auditVerdict: auditReport.verdict,
      auditScore: auditReport.score,
    });

    await this.recordTrace(
      { tenantId: input.tenantId, userId: input.userId },
      'EXECUTION_PLAN',
      builtContext,
      startedAt,
      firstRawResponse,
    );

    return plan;
  }

  /**
   * Registra una traza de observabilidad de una operación IA de alto nivel
   * (chat, recomendación o plan), delegando en {@link AiTraceRecorder}.
   */
  private recordTrace(
    actor: { readonly tenantId: string; readonly userId?: string },
    operation: AiContextOperation,
    builtContext: BuiltAiContext | undefined,
    startedAt: number,
    responseText?: string,
    error?: unknown,
  ): Promise<void> {
    return this.traceRecorder.record({
      tenantId: actor.tenantId,
      ...(actor.userId !== undefined ? { userId: actor.userId } : {}),
      operation,
      model: this.mainModel,
      ...(builtContext !== undefined ? { builtContext } : {}),
      startedAt,
      ...(responseText !== undefined ? { responseText } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }
}

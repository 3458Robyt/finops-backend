import type { IAiGateway } from '../../domain/interfaces/IAiGateway.js';
import type { ICostAnalyticsRepository } from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { IAgentLearningContextProvider } from '../../domain/interfaces/IAgentLearningService.js';
import type { IContextEngineService } from '../../domain/interfaces/IContextEngineService.js';
import type { RecommendationExecutionPlan } from '../../domain/models/RecommendationExecutionPlan.js';
import type { AiObservabilityService } from './AiObservabilityService.js';
import { FinOpsContextAssembler } from './ai/finOpsContextAssembler.js';
import { AiTraceRecorder } from './ai/aiTraceRecorder.js';
import { FinOpsArtifactGenerator } from './ai/finOpsArtifactGenerator.js';
import type { TechnicalRecommendationEvidenceProvider } from './ai/TechnicalRecommendationEvidenceService.js';
import { FinOpsAiChatRunner } from './ai/FinOpsAiChatRunner.js';
import { FinOpsAiExecutionPlanRunner } from './ai/FinOpsAiExecutionPlanRunner.js';
import { FinOpsAiRecommendationRunner } from './ai/FinOpsAiRecommendationRunner.js';
import { FinOpsAiRecommendationPreparer } from './ai/FinOpsAiRecommendationPreparer.js';
import { loadRuntimeConfig } from '../../infrastructure/config/runtimeConfigReader.js';
import type { RuntimeConfig } from '../../infrastructure/config/runtimeConfigTypes.js';

// Reexporta los contratos públicos para preservar la API del servicio.
export type {
  AiChatInput,
  AiChatMessage,
  AiChatResponse,
  GenerateAiRecommendationsInput,
  GenerateAiRecommendationsResponse,
  GenerateExecutionPlanInput,
  PreparedRecommendationAnalysis,
} from './ai/finOpsAiTypes.js';

import type {
  AiChatInput,
  AiChatResponse,
  GenerateAiRecommendationsInput,
  GenerateAiRecommendationsResponse,
  GenerateExecutionPlanInput,
  PreparedRecommendationAnalysis,
} from './ai/finOpsAiTypes.js';

/** Veredicto de auditoría requerido para aceptar el artefacto generado por IA. */
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
  private readonly chatRunner: FinOpsAiChatRunner;
  private readonly executionPlanRunner: FinOpsAiExecutionPlanRunner;
  private readonly recommendationPreparer: FinOpsAiRecommendationPreparer;
  private readonly recommendationRunner: FinOpsAiRecommendationRunner;

  /**
   * @param analyticsRepository      - Repositorio de analítica de costos (snapshots).
   * @param recommendationRepository - Repositorio de recomendaciones y planes de ejecución.
   * @param aiGateway                - Pasarela hacia el proveedor IA.
   * @param learningContextProvider  - Proveedor opcional de contexto de aprendizaje auditado.
   * @param contextEngine            - Motor opcional de ensamblado de contexto.
   * @param aiObservability          - Servicio opcional de observabilidad/trazas IA.
   */
  constructor(
    analyticsRepository: ICostAnalyticsRepository,
    recommendationRepository: IRecommendationRepository,
    aiGateway: IAiGateway,
    learningContextProvider?: IAgentLearningContextProvider,
    contextEngine?: IContextEngineService,
    aiObservability?: AiObservabilityService,
    technicalEvidenceProvider?: TechnicalRecommendationEvidenceProvider,
    aiConfig: RuntimeConfig['ai'] = loadRuntimeConfig().ai,
  ) {
    this.mainModel = aiGateway.modelName ?? aiConfig.model;
    this.auditorModel = aiConfig.auditorModel || this.mainModel;
    if (this.mainModel === this.auditorModel) {
      console.warn('AI generator and auditor use the same model; deterministic quality gates remain required.');
    }
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
      technicalEvidenceProvider,
    );
    this.chatRunner = new FinOpsAiChatRunner(
      analyticsRepository,
      aiGateway,
      this.contextAssembler,
      this.traceRecorder,
      this.mainModel,
    );
    this.executionPlanRunner = new FinOpsAiExecutionPlanRunner(
      analyticsRepository,
      recommendationRepository,
      this.contextAssembler,
      this.artifactGenerator,
      this.traceRecorder,
      this.mainModel,
      this.auditorModel,
    );
    this.recommendationPreparer = new FinOpsAiRecommendationPreparer(
      analyticsRepository,
      this.contextAssembler,
      this.mainModel,
      this.auditorModel,
    );
    this.recommendationRunner = new FinOpsAiRecommendationRunner(
      recommendationRepository,
      this.contextAssembler,
      this.artifactGenerator,
      this.traceRecorder,
      this.recommendationPreparer,
      this.mainModel,
      this.auditorModel,
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
    return this.chatRunner.run(input);
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
    return this.recommendationRunner.run(input);
  }

  public async prepareRecommendationAnalysis(
    input: Pick<GenerateAiRecommendationsInput, 'tenantId' | 'externalResourceId' | 'cloudResourceId'>,
  ): Promise<PreparedRecommendationAnalysis> {
    return this.recommendationPreparer.prepare(input);
  }

  public getModelNames(): { readonly model: string; readonly auditorModel: string } {
    return { model: this.mainModel, auditorModel: this.auditorModel };
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
    return this.executionPlanRunner.run(input);
  }

}

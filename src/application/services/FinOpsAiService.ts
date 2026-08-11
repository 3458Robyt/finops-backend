import { AiAuditRejectedError, FinOpsBaseError } from '../../domain/errors/errors.js';
import { createHash } from 'node:crypto';
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
import { applyAuditEvidence, buildRecommendationDeduplicationKey } from './ai/recommendationEvidence.js';
import { FinOpsContextAssembler } from './ai/finOpsContextAssembler.js';
import { AiTraceRecorder } from './ai/aiTraceRecorder.js';
import { FinOpsArtifactGenerator } from './ai/finOpsArtifactGenerator.js';
import type { TechnicalRecommendationEvidenceProvider } from './ai/TechnicalRecommendationEvidenceService.js';
import type { RecommendationReadinessReport } from './ai/RecommendationReadinessGate.js';
import { buildDeterministicTrendAnalysis } from './ai/DeterministicTrendAnalysis.js';
import { looksLikeSpanish } from './ai/aiLanguageGuard.js';
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

      if (!looksLikeSpanish(answer)) {
        throw new FinOpsBaseError(
          'El proveedor IA devolvió una respuesta que no cumple el idioma español requerido.',
          'AI_RESPONSE_ERROR',
        );
      }

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
    if (input.cloudResourceId !== undefined && input.externalResourceId === undefined) {
      throw new FinOpsBaseError('cloudResourceId requiere externalResourceId para mantener el alcance canónico.', 'VALIDATION_ERROR');
    }
    const prepared = input.prepared ?? await this.prepareRecommendationAnalysis(input);
    const { snapshot, readinessReport, technicalEvidenceSnapshot } = prepared;
    if (readinessReport.candidates.length === 0) {
      return {
        recommendations: [],
        snapshot,
        persisted: input.persist === true,
        analysis: {
          readinessReport,
          ...(technicalEvidenceSnapshot !== undefined ? { technicalEvidenceSnapshot } : {}),
          evidenceHash: prepared.evidenceHash,
          generatedCount: 0,
          promptTokenEstimate: 0,
          responseTokenEstimate: 0,
          model: this.mainModel,
          auditorModel: this.auditorModel,
        },
      };
    }

    const assembled = await this.contextAssembler.assembleRecommendationContext({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      snapshot,
      ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
      ...(input.cloudResourceId !== undefined ? { cloudResourceId: input.cloudResourceId } : {}),
      ...(prepared.technicalEvidenceSnapshot !== undefined
        ? { technicalEvidenceSnapshot: prepared.technicalEvidenceSnapshot }
        : {}),
    });
    const { builtContext, systemPrompt, learningContext } = assembled;
    const governedSystemPrompt = [
      systemPrompt,
      'PREANALISIS DETERMINISTICO DE TENDENCIAS (hechos autorizados):',
      JSON.stringify(prepared.deterministicAnalysis, null, 2),
    ].join('\n\n');
    const startedAt = Date.now();

    await input.onStage?.('AI_GENERATION');
    const { drafts, auditReport, firstRawResponse } = await this.artifactGenerator.generateAuditedDrafts(
      input.tenantId,
      input.userId,
      snapshot,
      governedSystemPrompt,
      input.externalResourceId,
      input.cloudResourceId,
      technicalEvidenceSnapshot,
      prepared.deterministicAnalysis,
      readinessReport,
      () => input.onStage?.('AI_AUDIT'),
    );

    if (auditReport.verdict !== approvedAuditVerdict) {
      throw new AiAuditRejectedError('AI audit rejected recommendation output', {
        diagnosticId: this.buildAuditDiagnosticId(input.tenantId),
        audit: {
          ...auditReport,
          generatedCount: drafts.length,
          promptTokenEstimate: estimateTokens(governedSystemPrompt),
          responseTokenEstimate: estimateTokens(firstRawResponse),
          model: this.mainModel,
          auditorModel: this.auditorModel,
          readinessSummary: readinessReport.summary,
          candidates: readinessReport.candidates.map((candidate: RecommendationReadinessReport['candidates'][number]) => ({
            id: candidate.id,
            readiness: candidate.readiness,
            cloudAccountId: candidate.cloudAccountId,
            serviceName: candidate.serviceName,
            resourceId: candidate.resourceId,
            maxEstimatedMonthlySavings: candidate.maxEstimatedMonthlySavings,
            reasons: candidate.reasons,
          })),
        },
      });
    }

    const auditedDrafts = drafts.map((draft) => ({
      ...applyAuditEvidence(
        draft,
        auditReport,
        learningContext,
        technicalEvidenceSnapshot,
        input.analysisRunId,
      ),
      deduplicationKey: buildRecommendationDeduplicationKey(
        draft,
        snapshot.periodStart,
        snapshot.periodEnd,
      ),
    }));

    const persisted = input.persist === true;
    await input.onStage?.('PERSISTENCE');
    const recommendations = persisted
      ? await this.recommendationRepository.createMany(auditedDrafts)
      : auditedDrafts.map((draft, index) => toEphemeralRecommendation(draft, index));

    await this.recordTrace(input, 'RECOMMENDATION', builtContext, startedAt, firstRawResponse);

    return {
      recommendations,
      snapshot,
      persisted,
      analysis: {
        readinessReport,
        ...(technicalEvidenceSnapshot !== undefined ? { technicalEvidenceSnapshot } : {}),
        evidenceHash: prepared.evidenceHash,
        auditReport,
        generatedCount: drafts.length,
        promptTokenEstimate: estimateTokens(governedSystemPrompt),
        responseTokenEstimate: estimateTokens(firstRawResponse),
        model: this.mainModel,
        auditorModel: this.auditorModel,
      },
    };
  }

  public async prepareRecommendationAnalysis(
    input: Pick<GenerateAiRecommendationsInput, 'tenantId' | 'externalResourceId' | 'cloudResourceId'>,
  ): Promise<PreparedRecommendationAnalysis> {
    if (input.cloudResourceId !== undefined && input.externalResourceId === undefined) {
      throw new FinOpsBaseError('cloudResourceId requiere externalResourceId para mantener el alcance canónico.', 'VALIDATION_ERROR');
    }
    const tenantSnapshot = await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const snapshot = input.externalResourceId === undefined
      ? tenantSnapshot
      : scopeSnapshotToResource(tenantSnapshot, input.externalResourceId);
    const preparedEvidence = await this.contextAssembler.prepareRecommendationEvidence({
      tenantId: input.tenantId,
      snapshot,
      ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
      ...(input.cloudResourceId !== undefined ? { cloudResourceId: input.cloudResourceId } : {}),
    });
    const periodEnd = new Date(snapshot.periodEnd);
    const periodFrom = new Date(periodEnd);
    periodFrom.setUTCMonth(periodFrom.getUTCMonth() - 6);
    const trendFilters = {
      from: periodFrom,
      to: periodEnd,
      ...(input.externalResourceId !== undefined
        ? { groupBy: 'resource' as const }
        : { groupBy: 'service' as const }),
    };
    const [allCostSeries, allUsageSeries] = await Promise.all([
      this.analyticsRepository.getMonthlyCostSeries(input.tenantId, trendFilters),
      this.analyticsRepository.getMonthlyUsageSeries(input.tenantId, trendFilters),
    ]);
    const costSeries = input.externalResourceId === undefined
      ? allCostSeries
      : allCostSeries.filter((point) => point.resourceId === input.externalResourceId);
    const usageSeries = input.externalResourceId === undefined
      ? allUsageSeries
      : allUsageSeries.filter((point) => point.resourceId === input.externalResourceId);
    const deterministicAnalysis = buildDeterministicTrendAnalysis(costSeries, usageSeries);
    const evidenceHash = createHash('sha256').update(JSON.stringify({
      snapshot,
      technicalEvidenceHash: preparedEvidence.technicalEvidenceSnapshot?.hash ?? null,
      deterministicAnalysis,
    })).digest('hex');

    return {
      snapshot,
      readinessReport: preparedEvidence.readinessReport,
      ...(preparedEvidence.technicalEvidenceSnapshot !== undefined
        ? { technicalEvidenceSnapshot: preparedEvidence.technicalEvidenceSnapshot }
        : {}),
      evidenceHash,
      deterministicAnalysis,
      model: this.mainModel,
      auditorModel: this.auditorModel,
    };
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

    await this.recordTrace(
      { tenantId: input.tenantId, userId: input.userId },
      'EXECUTION_PLAN',
      builtContext,
      startedAt,
      firstRawResponse,
    );

    if (auditReport.verdict !== approvedAuditVerdict) {
      throw new AiAuditRejectedError('AI audit rejected execution plan output', {
        diagnosticId: this.buildAuditDiagnosticId(input.tenantId),
        audit: auditReport,
      });
    }

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

  private buildAuditDiagnosticId(tenantId: string): string {
    return `audit-${tenantId}-${Date.now().toString(36)}`;
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function scopeSnapshotToResource(
  snapshot: import('../../domain/interfaces/ICostAnalyticsRepository.js').CostAnalyticsSnapshot,
  externalResourceId: string,
): import('../../domain/interfaces/ICostAnalyticsRepository.js').CostAnalyticsSnapshot {
  const topResources = snapshot.topResources.filter((resource) => resource.resourceId === externalResourceId);
  if (topResources.length === 0) {
    throw new FinOpsBaseError('No existe evidencia de costo para el recurso solicitado', 'VALIDATION_ERROR');
  }

  const totalCost = topResources.reduce((sum, resource) => sum + resource.totalCost, 0);
  const metricCount = topResources.reduce((sum, resource) => sum + resource.metricCount, 0);
  const { topUsage: _topUsage, usageInsights: _usageInsights, anomalies: _anomalies, forecasts: _forecasts, ...base } = snapshot;
  return {
    ...base,
    totalCost,
    metricCount,
    providers: snapshot.providers.filter((provider) => provider.provider === topResources[0]!.provider),
    accounts: snapshot.accounts.filter((account) => account.provider === topResources[0]!.provider),
    services: snapshot.services.filter((service) => (
      service.provider === topResources[0]!.provider && service.serviceName === topResources[0]!.serviceName
    )),
    environments: [],
    topResources,
    topUsage: (snapshot.topUsage ?? []).filter((usage) => (
      usage.provider === topResources[0]!.provider && usage.serviceName === topResources[0]!.serviceName
    )),
  };
}

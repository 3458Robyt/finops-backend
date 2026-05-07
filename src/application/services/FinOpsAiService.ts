import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IAiGateway } from '../../domain/interfaces/IAiGateway.js';
import type {
  CostAnalyticsSnapshot,
  ICostAnalyticsRepository,
} from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type {
  CreateRecommendationInput,
  IRecommendationRepository,
} from '../../domain/interfaces/IRecommendationRepository.js';
import type {
  AgentLearningContext,
  IAgentLearningContextProvider,
} from '../../domain/interfaces/IAgentLearningService.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import type {
  AiAuditReport,
  RecommendationExecutionPlan,
} from '../../domain/models/RecommendationExecutionPlan.js';

export interface AiChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AiChatInput {
  readonly tenantId: string;
  readonly message: string;
  readonly history?: readonly AiChatMessage[];
}

export interface AiChatResponse {
  readonly answer: string;
  readonly snapshot: CostAnalyticsSnapshot;
}

export interface GenerateAiRecommendationsInput {
  readonly tenantId: string;
  readonly persist?: boolean;
}

export interface GenerateAiRecommendationsResponse {
  readonly recommendations: readonly FinOpsRecommendation[];
  readonly snapshot: CostAnalyticsSnapshot;
  readonly persisted: boolean;
}

export interface GenerateExecutionPlanInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly recommendationId: string;
}

type AiRecommendationDraft = Omit<CreateRecommendationInput, 'tenantId'>;

const supportedSeverities = new Set<FinOpsRecommendation['severity']>([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
]);

const approvedAuditVerdict = 'APPROVED';

export class FinOpsAiService {
  private readonly mainModel: string;
  private readonly auditorModel: string;

  constructor(
    private readonly analyticsRepository: ICostAnalyticsRepository,
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly aiGateway: IAiGateway,
    private readonly learningContextProvider?: IAgentLearningContextProvider,
  ) {
    this.mainModel = aiGateway.modelName ?? process.env['NVIDIA_MODEL'] ?? 'deepseek-ai/deepseek-v4-flash';
    this.auditorModel = process.env['NVIDIA_AUDITOR_MODEL'] ?? this.mainModel;
  }

  public async answerChat(input: AiChatInput): Promise<AiChatResponse> {
    const message = input.message.trim();

    if (message === '') {
      throw new FinOpsBaseError('Chat message is required', 'VALIDATION_ERROR');
    }

    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const answer = await this.aiGateway.generateText({
      responseFormat: 'text',
      temperature: 0.3,
      maxTokens: 900,
      messages: [
        {
          role: 'system',
          content: this.buildChatSystemPrompt(snapshot),
        },
        ...this.normalizeHistory(input.history),
        {
          role: 'user',
          content: message,
        },
      ],
    });

    return {
      answer: answer.trim(),
      snapshot,
    };
  }

  public async generateRecommendations(
    input: GenerateAiRecommendationsInput,
  ): Promise<GenerateAiRecommendationsResponse> {
    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const learningContext = await this.getRecommendationLearningContext(input.tenantId, snapshot);
    const firstRawResponse = await this.aiGateway.generateText({
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 900,
      messages: [
        {
          role: 'system',
          content: this.buildRecommendationSystemPrompt(snapshot, learningContext),
        },
        {
          role: 'user',
          content: 'Genera exactamente 3 recomendaciones FinOps priorizadas en español a partir de este contexto.',
        },
      ],
    });

    let drafts = this.parseRecommendationDrafts(firstRawResponse, snapshot)
      .map((draft) => ({
        tenantId: input.tenantId,
        ...draft,
      }));
    let auditReport = await this.auditGeneratedArtifact({
      artifactType: 'recommendations',
      snapshot,
      artifact: drafts,
    });

    if (auditReport.verdict === 'NEEDS_REVISION') {
      const revisedRawResponse = await this.aiGateway.generateText({
        responseFormat: 'json',
        temperature: 0.2,
        maxTokens: 900,
        messages: [
          {
            role: 'system',
            content: this.buildRecommendationSystemPrompt(snapshot, learningContext),
          },
          {
            role: 'user',
            content: [
              'Corrige las recomendaciones usando exactamente estos cambios requeridos por auditoria.',
              'No agregues cuentas, proveedores ni recursos que no esten en el contexto.',
              JSON.stringify(auditReport.requiredChanges, null, 2),
            ].join('\n'),
          },
        ],
      });
      drafts = this.parseRecommendationDrafts(revisedRawResponse, snapshot)
        .map((draft) => ({
          tenantId: input.tenantId,
          ...draft,
        }));
      auditReport = await this.auditGeneratedArtifact({
        artifactType: 'recommendations',
        snapshot,
        artifact: drafts,
      });
    }

    if (auditReport.verdict !== approvedAuditVerdict) {
      throw new FinOpsBaseError('AI audit rejected recommendation output', 'AI_AUDIT_REJECTED');
    }

    const auditedDrafts = drafts.map((draft) => ({
      ...draft,
        evidence: {
          ...(this.isRecord(draft.evidence) ? draft.evidence : {}),
          aiAudit: auditReport,
          ...(learningContext.summary !== ''
            ? {
                aiLearning: {
                  memoryIds: learningContext.memoryIds,
                  caseIds: learningContext.caseIds,
                  summary: learningContext.summary,
                },
              }
            : {}),
        },
      }));

    const persisted = input.persist === true;
    const recommendations = persisted
      ? await this.recommendationRepository.createMany(auditedDrafts)
      : auditedDrafts.map((draft, index) => this.toEphemeralRecommendation(draft, index));

    return {
      recommendations,
      snapshot,
      persisted,
    };
  }

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
    const firstRawResponse = await this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 1200,
      messages: [
        {
          role: 'system',
          content: this.buildExecutionPlanSystemPrompt(snapshot, recommendation),
        },
        {
          role: 'user',
          content: 'Genera un plan de ejecucion manual, verificable y en español para esta recomendacion.',
        },
      ],
    });
    let content = this.parseExecutionPlan(firstRawResponse, recommendation);
    let auditReport = await this.auditGeneratedArtifact({
      artifactType: 'execution_plan',
      snapshot,
      recommendation,
      artifact: content,
    });

    if (auditReport.verdict === 'NEEDS_REVISION') {
      const revisedRawResponse = await this.aiGateway.generateText({
        model: this.mainModel,
        responseFormat: 'json',
        temperature: 0.2,
        maxTokens: 1200,
        messages: [
          {
            role: 'system',
            content: this.buildExecutionPlanSystemPrompt(snapshot, recommendation),
          },
          {
            role: 'user',
            content: [
              'Corrige el plan de ejecucion usando exactamente estos cambios requeridos por auditoria.',
              'Mantiene el alcance manual y no prometas ejecucion automatica.',
              JSON.stringify(auditReport.requiredChanges, null, 2),
            ].join('\n'),
          },
        ],
      });
      content = this.parseExecutionPlan(revisedRawResponse, recommendation);
      auditReport = await this.auditGeneratedArtifact({
        artifactType: 'execution_plan',
        snapshot,
        recommendation,
        artifact: content,
      });
    }

    return this.recommendationRepository.createExecutionPlan({
      recommendationId: recommendation.id,
      generatedByUserId: input.userId,
      model: this.mainModel,
      auditorModel: this.auditorModel,
      content,
      auditReport,
      auditVerdict: auditReport.verdict,
      auditScore: auditReport.score,
    });
  }

  private buildChatSystemPrompt(snapshot: CostAnalyticsSnapshot): string {
    return [
      'Eres un asistente IA FinOps para FinOps Demo.',
      'Debes responder siempre en español, con orientación operativa y concisa.',
      'Usa solo el contexto FOCUS proporcionado como fuente factual. Si falta información, indícalo.',
      'FOCUS puede incluir consumo facturado y unidades, pero no CPU, memoria, IOPS, throughput ni utilización técnica.',
      'No inventes recursos cloud, métricas técnicas ni ahorros.',
      'Contexto de costos y consumo:',
      JSON.stringify(this.compactSnapshot(snapshot), null, 2),
    ].join('\n');
  }

  private buildRecommendationSystemPrompt(
    snapshot: CostAnalyticsSnapshot,
    learningContext: AgentLearningContext,
  ): string {
    return [
      'Eres un motor IA de optimización FinOps.',
      'Analiza el contexto FOCUS proporcionado y produce recomendaciones como JSON estricto.',
      'Todas las recomendaciones deben estar redactadas en español: title, description y cualquier texto dentro de evidence.',
      'Devuelve solo esta forma: {"recommendations":[{"cloudAccountId":"...","type":"...","severity":"LOW|MEDIUM|HIGH|CRITICAL","title":"...","description":"...","estimatedMonthlySavings":0,"currency":"USD","evidence":{}}]}',
      'Usa solo cloudAccountId presentes en accounts. No inventes recursos ni proveedores.',
      'Usa topUsage y unit economics cuando existan. Incluye evidence.evidenceLevel como COST_ONLY, COST_AND_USAGE o COST_USAGE_AND_TECHNICAL.',
      'FOCUS aporta consumo facturado, no métricas técnicas como CPU, memoria, IOPS, throughput o utilización. No hagas rightsizing técnico fuerte si solo existe FOCUS; marca evidence.requiresTechnicalValidation=true.',
      'Prioriza recomendaciones accionables: ciclo de vida de almacenamiento, compromisos/descuentos por consumo estable, investigación de divergencia costo-consumo, revisión de bases de datos y egreso de red.',
      'El contexto de aprendizaje auditado orienta criterios, riesgos y patrones de aceptacion o rechazo; no lo trates como dato factual de costos.',
      learningContext.summary === ''
        ? 'Contexto de aprendizaje auditado: no hay patrones previos relevantes.'
        : [
            'Contexto de aprendizaje auditado:',
            learningContext.summary,
            `Memorias usadas: ${learningContext.memoryIds.join(', ') || 'ninguna'}`,
            `Casos usados: ${learningContext.caseIds.join(', ') || 'ninguno'}`,
          ].join('\n'),
      'Contexto:',
      JSON.stringify(this.compactSnapshot(snapshot), null, 2),
    ].join('\n');
  }

  private async getRecommendationLearningContext(
    tenantId: string,
    snapshot: CostAnalyticsSnapshot,
  ): Promise<AgentLearningContext> {
    if (this.learningContextProvider === undefined) {
      return {
        memoryIds: [],
        caseIds: [],
        summary: '',
      };
    }

    return this.learningContextProvider.getRecommendationLearningContext({
      tenantId,
      queryText: [
        ...snapshot.providers.map((item) => item.provider),
        ...snapshot.services.map((item) => item.serviceName),
        ...snapshot.topResources.map((item) => item.resourceId),
        ...(snapshot.topUsage ?? []).map((item) => `${item.serviceName} ${item.consumedUnit}`),
      ].join(' '),
      limit: 5,
    });
  }

  private buildExecutionPlanSystemPrompt(
    snapshot: CostAnalyticsSnapshot,
    recommendation: FinOpsRecommendation,
  ): string {
    return [
      'Eres un arquitecto FinOps senior para FinOps Demo.',
      'Debes generar un plan de ejecucion manual, gobernado y en español.',
      'No afirmes que el sistema ejecutara cambios automaticamente en AWS, OCI u otro proveedor.',
      'Usa solo la recomendacion, evidencia y contexto FOCUS proporcionados. No inventes recursos, cuentas, metricas tecnicas ni proveedores.',
      'Si la recomendacion solo tiene evidencia FOCUS, indica que CPU, memoria, IOPS o throughput deben validarse fuera de FOCUS antes de ejecutar cambios tecnicos.',
      'Devuelve solo JSON estricto con esta forma:',
      '{"summary":"...","scope":{"cloudAccountId":"...","service":"..."},"prerequisites":["..."],"steps":["..."],"validation":["..."],"risks":["..."],"rollback":["..."],"successCriteria":["..."],"estimatedSavings":{"amount":0,"currency":"USD"}}',
      'Contexto de costos:',
      JSON.stringify(this.compactSnapshot(snapshot), null, 2),
      'Recomendacion:',
      JSON.stringify(recommendation, null, 2),
    ].join('\n');
  }

  private buildAuditSystemPrompt(): string {
    return [
      'Eres un agente auditor FinOps independiente para FinOps Demo.',
      'Tu tarea es auditar contenido generado por otro agente IA antes de que sea persistido o aprobado.',
      'Debes comprobar que el contenido este en español, sea consistente con los datos, no invente recursos, sea realista, viable y tenga validaciones suficientes.',
      'Verifica que el contenido no trate consumo FOCUS como CPU, memoria, IOPS, throughput o utilizacion tecnica.',
      'Rechaza cualquier contenido que prometa ejecucion automatica real de cambios cloud.',
      'Devuelve solo JSON estricto con esta forma:',
      '{"verdict":"APPROVED|REJECTED|NEEDS_REVISION","score":0,"checks":[{"name":"...","passed":true,"notes":"..."}],"blockingIssues":["..."],"requiredChanges":["..."]}',
      'Usa APPROVED solo si no hay problemas bloqueantes y el score es mayor o igual a 80.',
    ].join('\n');
  }

  private compactSnapshot(snapshot: CostAnalyticsSnapshot): unknown {
    return {
      tenantId: snapshot.tenantId,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
      totalCost: snapshot.totalCost,
      currency: snapshot.currency,
      metricCount: snapshot.metricCount,
      providers: snapshot.providers,
      accounts: snapshot.accounts.slice(0, 4),
      services: snapshot.services.slice(0, 6),
      environments: snapshot.environments,
      topResources: snapshot.topResources.slice(0, 6),
      topUsage: snapshot.topUsage?.slice(0, 8) ?? [],
      usageInsights: snapshot.usageInsights?.slice(0, 8) ?? [],
      anomalies: snapshot.anomalies?.slice(0, 5) ?? [],
      forecasts: snapshot.forecasts?.slice(0, 6) ?? [],
    };
  }

  private normalizeHistory(history: readonly AiChatMessage[] | undefined): AiChatMessage[] {
    if (history === undefined) {
      return [];
    }

    return history
      .slice(-8)
      .map((item) => ({
        role: item.role,
        content: item.content.trim(),
      }))
      .filter((item) => item.content !== '');
  }

  private parseRecommendationDrafts(
    rawResponse: string,
    snapshot: CostAnalyticsSnapshot,
  ): readonly AiRecommendationDraft[] {
    const json = this.extractJson(rawResponse);
    const parsed = JSON.parse(json) as unknown;
    const container = this.isRecord(parsed) ? parsed : {};
    const rawRecommendations = Array.isArray(container['recommendations'])
      ? container['recommendations']
      : [];

    const allowedAccountIds = new Set(snapshot.accounts.map((account) => account.cloudAccountId));

    const drafts = rawRecommendations
      .map((item) => this.toRecommendationDraft(item, allowedAccountIds, snapshot.currency))
      .filter((item): item is AiRecommendationDraft => item !== null);

    if (drafts.length === 0) {
      throw new FinOpsBaseError('AI did not return valid recommendations', 'AI_RESPONSE_ERROR');
    }

    return drafts;
  }

  private parseExecutionPlan(
    rawResponse: string,
    recommendation: FinOpsRecommendation,
  ): Record<string, unknown> {
    const json = this.extractJson(rawResponse);
    const parsed = JSON.parse(json) as unknown;

    if (!this.isRecord(parsed)) {
      throw new FinOpsBaseError('AI did not return a valid execution plan', 'AI_RESPONSE_ERROR');
    }

    const requiredArrayFields = [
      'prerequisites',
      'steps',
      'validation',
      'risks',
      'rollback',
      'successCriteria',
    ];

    const hasRequiredArrays = requiredArrayFields.every((field) => (
      Array.isArray(parsed[field]) &&
      (parsed[field] as unknown[]).every((item) => typeof item === 'string' && item.trim() !== '')
    ));

    if (
      this.readString(parsed, 'summary') === undefined ||
      !this.isRecord(parsed['scope']) ||
      !hasRequiredArrays ||
      !this.isRecord(parsed['estimatedSavings'])
    ) {
      throw new FinOpsBaseError('AI did not return a complete execution plan', 'AI_RESPONSE_ERROR');
    }

    return {
      ...parsed,
      recommendationId: recommendation.id,
      cloudAccountId: recommendation.cloudAccountId,
      generatedBy: 'nvidia-nim',
    };
  }

  private async auditGeneratedArtifact(input: {
    readonly artifactType: 'recommendations' | 'execution_plan';
    readonly snapshot: CostAnalyticsSnapshot;
    readonly recommendation?: FinOpsRecommendation;
    readonly artifact: unknown;
  }): Promise<AiAuditReport> {
    const rawResponse = await this.aiGateway.generateText({
      model: this.auditorModel,
      responseFormat: 'json',
      temperature: 0,
      maxTokens: 900,
      messages: [
        {
          role: 'system',
          content: this.buildAuditSystemPrompt(),
        },
        {
          role: 'user',
          content: [
            `Audita este artefacto: ${input.artifactType}.`,
            'Contexto autorizado:',
            JSON.stringify(this.compactSnapshot(input.snapshot), null, 2),
            ...(input.recommendation !== undefined
              ? ['Recomendacion original:', JSON.stringify(input.recommendation, null, 2)]
              : []),
            'Artefacto generado:',
            JSON.stringify(input.artifact, null, 2),
          ].join('\n'),
        },
      ],
    });

    return this.parseAuditReport(rawResponse);
  }

  private parseAuditReport(rawResponse: string): AiAuditReport {
    const parsed = JSON.parse(this.extractJson(rawResponse)) as unknown;

    if (!this.isRecord(parsed)) {
      throw new FinOpsBaseError('AI auditor did not return a valid report', 'AI_RESPONSE_ERROR');
    }

    const verdict = this.readString(parsed, 'verdict')?.toUpperCase();
    const score = this.readNumber(parsed, 'score');
    const checks = Array.isArray(parsed['checks']) ? parsed['checks'] : [];
    const blockingIssues = this.readStringList(parsed['blockingIssues']);
    const requiredChanges = this.readStringList(parsed['requiredChanges']);

    if (
      (verdict !== 'APPROVED' && verdict !== 'REJECTED' && verdict !== 'NEEDS_REVISION') ||
      score === undefined ||
      score < 0 ||
      score > 100
    ) {
      throw new FinOpsBaseError('AI auditor returned an invalid verdict', 'AI_RESPONSE_ERROR');
    }

    return {
      verdict,
      score,
      checks: checks
        .filter((item): item is Record<string, unknown> => this.isRecord(item))
        .map((item) => ({
          name: this.readString(item, 'name') ?? 'verificacion',
          passed: item['passed'] === true,
          notes: this.readString(item, 'notes') ?? '',
        })),
      blockingIssues,
      requiredChanges,
    };
  }

  private toRecommendationDraft(
    value: unknown,
    allowedAccountIds: ReadonlySet<string>,
    defaultCurrency: string,
  ): AiRecommendationDraft | null {
    if (!this.isRecord(value)) {
      return null;
    }

    const cloudAccountId = this.readString(value, 'cloudAccountId');
    const type = this.readString(value, 'type');
    const severity = this.readString(value, 'severity')?.toUpperCase();
    const title = this.readString(value, 'title');
    const description = this.readString(value, 'description');

    if (
      cloudAccountId === undefined ||
      !allowedAccountIds.has(cloudAccountId) ||
      type === undefined ||
      severity === undefined ||
      !supportedSeverities.has(severity as FinOpsRecommendation['severity']) ||
      title === undefined ||
      description === undefined
    ) {
      return null;
    }

    const estimatedMonthlySavings = this.readNumber(value, 'estimatedMonthlySavings');
    const currency = this.readString(value, 'currency') ?? defaultCurrency;
    const evidence = this.isRecord(value['evidence']) ? value['evidence'] : {};
    const evidenceLevel = this.readEvidenceLevel(evidence) ?? 'COST_AND_USAGE';

    return {
      cloudAccountId,
      type,
      severity: severity as FinOpsRecommendation['severity'],
      title,
      description,
      evidence: {
        source: 'nvidia-nim',
        evidenceLevel,
        focusLimitation: 'FOCUS contiene costo y consumo facturado; no contiene CPU, memoria, IOPS, throughput ni utilizacion tecnica.',
        ...evidence,
      },
      ...(estimatedMonthlySavings !== undefined ? { estimatedMonthlySavings } : {}),
      currency,
    };
  }

  private extractJson(rawResponse: string): string {
    const trimmed = rawResponse.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);

    if (fenced?.[1] !== undefined) {
      return fenced[1].trim();
    }

    return trimmed;
  }

  private toEphemeralRecommendation(
    input: CreateRecommendationInput,
    index: number,
  ): FinOpsRecommendation {
    const now = new Date();

    return {
      id: `ai-preview-${index + 1}`,
      cloudAccountId: input.cloudAccountId,
      type: input.type,
      status: 'PENDING',
      severity: input.severity,
      title: input.title,
      description: input.description,
      evidence: input.evidence,
      ...(input.estimatedMonthlySavings !== undefined
        ? { estimatedMonthlySavings: input.estimatedMonthlySavings }
        : {}),
      currency: input.currency,
      createdAt: now,
      updatedAt: now,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];

    if (typeof value !== 'string' || value.trim() === '') {
      return undefined;
    }

    return value.trim();
  }

  private readNumber(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private readEvidenceLevel(record: Record<string, unknown>): string | undefined {
    const raw = this.readString(record, 'evidenceLevel')?.toUpperCase();

    if (
      raw === 'COST_ONLY' ||
      raw === 'COST_AND_USAGE' ||
      raw === 'COST_USAGE_AND_TECHNICAL'
    ) {
      return raw;
    }

    return undefined;
  }

  private readStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  }
}

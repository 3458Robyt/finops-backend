import type { AiGatewayRequest, AiReasoningEffort, IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import { ProviderTimeoutError } from '../../../domain/errors/errors.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import {
  buildAuditSystemPrompt,
  compactSnapshot,
} from './finOpsAiPrompts.js';
import { compactExecutionPlanArtifact, compactExecutionPlanContext } from './executionPlanPromptContext.js';
import { parseAuditReport } from './finOpsAiResponseParser.js';
import type { AiTraceRecorder } from './aiTraceRecorder.js';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type { DeterministicTrendAnalysis } from './DeterministicTrendAnalysis.js';
import type { RecommendationReadinessReport } from './RecommendationReadinessGate.js';
import { compactRecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';

export interface ArtifactAuditInput {
  readonly artifactType: 'recommendations' | 'execution_plan';
  readonly snapshot: CostAnalyticsSnapshot;
  readonly recommendation?: FinOpsRecommendation;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly artifact: unknown;
  readonly technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot;
  readonly deterministicAnalysis?: DeterministicTrendAnalysis;
  readonly readinessReport?: RecommendationReadinessReport;
  readonly deadlineAt?: number;
}

export interface AiArtifactRequestPolicy {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly reasoningEffort?: AiReasoningEffort;
}

/**
 * Boundary for model calls used by recommendation and execution-plan artifacts.
 * It keeps prompt assembly, model selection and audit tracing out of the
 * orchestration class while preserving the existing gateway contract.
 */
export class FinOpsArtifactAiRunner {
  public constructor(
    private readonly aiGateway: IAiGateway,
    private readonly traceRecorder: AiTraceRecorder,
    private readonly mainModel: string,
    private readonly auditorModel: string,
    private readonly requestPolicy: AiArtifactRequestPolicy = { timeoutMs: 60_000, maxRetries: 1, reasoningEffort: 'low' },
  ) {}

  public generateRecommendations(systemPrompt: string): Promise<string> {
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      // Keep one generate+audit pass below the 120 s hard limit: 70 s for the
      // artifact and 50 s for the mandatory auditor. The gateway enforces both
      // budgets as strict wall-clock deadlines.
      timeoutMs: Math.min(this.requestPolicy.timeoutMs, 70_000),
      maxRetries: 0,
      ...(this.requestPolicy.reasoningEffort === undefined ? {} : { reasoningEffort: this.requestPolicy.reasoningEffort }),
      // Las recomendaciones deben ser reproducibles: el contenido creativo
      // está acotado por candidatos/evidencia y no necesita aleatoriedad.
      temperature: 0,
      maxTokens: 750,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content:
            'Genera hasta 2 recomendaciones FinOps priorizadas en español usando solo candidatos GENERATABLE autorizados. Si ninguno permite una oportunidad segura y accionable, responde exactamente {"recommendations":[]}; no propongas recomendaciones de validación.',
        },
      ],
    });
  }

  public generateReviewDrafts(systemPrompt: string, deadlineAt?: number): Promise<string> {
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      timeoutMs: this.getRequestTimeout(70_000, deadlineAt),
      maxRetries: 0,
      ...(this.requestPolicy.reasoningEffort === undefined ? {} : { reasoningEffort: this.requestPolicy.reasoningEffort }),
      temperature: 0,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: 'Redacta hasta cinco borradores provisionales de revisión técnica usando únicamente los candidatos proporcionados. Devuelve JSON estricto con la propiedad recommendations. No inventes uso, métricas, fallas ni ahorros; si no puedes aportar una revisión concreta, devuelve {"recommendations":[]}.',
        },
      ],
    });
  }

  public reviseRecommendations(systemPrompt: string, requiredChanges: readonly string[]): Promise<string> {
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      timeoutMs: Math.min(this.requestPolicy.timeoutMs, 70_000),
      maxRetries: 0,
      ...(this.requestPolicy.reasoningEffort === undefined ? {} : { reasoningEffort: this.requestPolicy.reasoningEffort }),
      temperature: 0,
      maxTokens: 900,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            'Corrige las recomendaciones usando exactamente estos cambios requeridos por auditoria.',
            'No agregues cuentas, proveedores ni recursos que no esten en el contexto.',
            'Conserva evidence.candidateId, sourceFacts, assumptions y confidence en cada recomendacion.',
            JSON.stringify(requiredChanges),
          ].join('\n'),
        },
      ],
    });
  }

  public generateExecutionPlan(systemPrompt: string, deadlineAt?: number): Promise<string> {
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      timeoutMs: this.getRequestTimeout(70_000, deadlineAt),
      maxRetries: 0,
      ...(this.requestPolicy.reasoningEffort === undefined ? {} : { reasoningEffort: this.requestPolicy.reasoningEffort }),
      temperature: 0,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: 'Genera un plan de ejecucion manual, verificable y en español para esta recomendacion.',
        },
      ],
    });
  }

  public reviseExecutionPlan(
    systemPrompt: string,
    requiredChanges: readonly string[],
    currentPlan?: Record<string, unknown>,
    deadlineAt?: number,
  ): Promise<string> {
    const planForRepair = currentPlan === undefined ? undefined : omitEstimatedSavings(currentPlan);
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      timeoutMs: this.getRequestTimeout(70_000, deadlineAt),
      maxRetries: 0,
      ...(this.requestPolicy.reasoningEffort === undefined ? {} : { reasoningEffort: this.requestPolicy.reasoningEffort }),
      temperature: 0,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            'Corrige el plan de ejecucion usando exactamente estos cambios requeridos por auditoria.',
            'Mantiene el alcance manual y no prometas ejecucion automatica.',
            'Cada paso operativo debe incluir en la misma frase la condicion de aprobacion externa previa del responsable; usa una forma explicita como "Solo despues de la aprobacion externa explicita del responsable, la persona autorizada podra ejecutar manualmente el cambio". La validacion tecnica no sustituye esa aprobacion.',
            'Conserva el estado de gestion de la recomendacion y el alcance del plan; no inventes periodos, recursos ni estados.',
            'No incluyas cifras monetarias en el texto narrativo. Devuelve el placeholder estimatedSavings; el servidor lo normaliza desde evidencia deterministica.',
            JSON.stringify(requiredChanges),
            ...(planForRepair === undefined ? [] : ['Plan actual que debes corregir:', JSON.stringify(planForRepair)]),
          ].join('\n'),
        },
      ],
    });
  }

  public async auditArtifact(input: ArtifactAuditInput): Promise<AiAuditReport> {
    const startedAt = Date.now();
    const isExecutionPlan = input.artifactType === 'execution_plan';
    const executionPlanContext = isExecutionPlan
      ? compactExecutionPlanContext(input.snapshot, input.recommendation)
      : undefined;
    const request: AiGatewayRequest = {
      model: this.auditorModel,
      responseFormat: 'json',
      // The auditor is a mandatory gate, but a failed provider must not turn a
      // recommendation run into a multi-minute retry chain.
      timeoutMs: this.getRequestTimeout(50_000, input.deadlineAt),
      maxRetries: 0,
      ...(this.requestPolicy.reasoningEffort === undefined ? {} : { reasoningEffort: this.requestPolicy.reasoningEffort }),
      temperature: 0,
      maxTokens: 900,
      messages: [
        { role: 'system', content: buildAuditSystemPrompt(input.artifactType) },
        {
          role: 'user',
          content: [
            `Audita este artefacto: ${input.artifactType}.`,
            'Contexto autorizado:',
            JSON.stringify(executionPlanContext ?? compactSnapshot(input.snapshot)),
            ...(input.technicalEvidenceSnapshot === undefined
              ? []
              : [
                  'Evidencia tecnica canonica:',
                  JSON.stringify(compactRecommendationEvidenceSnapshot(
                    input.technicalEvidenceSnapshot,
                    input.readinessReport?.candidates,
                  )),
                ]),
            ...(input.deterministicAnalysis === undefined
              ? []
              : ['Preanalisis deterministico de tendencias:', JSON.stringify(input.deterministicAnalysis)]),
            ...(input.readinessReport === undefined
              ? []
              : [
                  'Candidatos autorizados por la compuerta deterministica (candidateId pertenece a esta lista):',
                  JSON.stringify(compactReadinessReport(input.readinessReport)),
                ]),
            ...(input.recommendation === undefined
              ? []
              : ['Recomendacion original:', JSON.stringify(executionPlanContext?.['recommendation'] ?? input.recommendation)]),
            'Artefacto generado:',
            JSON.stringify(isExecutionPlan ? compactExecutionPlanArtifact(input.artifact) : input.artifact),
          ].join('\n'),
        },
      ],
    };
    let rawResponse: string;
    let auditReport: AiAuditReport;
    try {
      rawResponse = await this.aiGateway.generateText(request);
      auditReport = parseAuditReport(rawResponse);
    } catch (error) {
      if (input.tenantId !== undefined) {
        await this.recordAuditTrace({
          tenantId: input.tenantId,
          ...(input.userId === undefined ? {} : { userId: input.userId }),
          operation: 'AUDIT',
          model: this.auditorModel,
          startedAt,
          error,
        });
      }
      throw error;
    }

    if (input.tenantId !== undefined) {
      await this.recordAuditTrace({
        tenantId: input.tenantId,
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        operation: 'AUDIT',
        model: this.auditorModel,
        startedAt,
        responseText: rawResponse,
      });
    }

    return auditReport;
  }

  private async recordAuditTrace(input: Parameters<AiTraceRecorder['record']>[0]): Promise<void> {
    try {
      await this.traceRecorder.record(input);
    } catch {
      // Audit trace persistence is observability and must not change the audit result.
    }
  }

  private getRequestTimeout(maxRequestMs: number, deadlineAt?: number): number {
    const requestLimit = Math.min(this.requestPolicy.timeoutMs, maxRequestMs);
    if (deadlineAt === undefined) return requestLimit;

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new ProviderTimeoutError('La generación del plan excedió el plazo total permitido.');
    }
    return Math.min(requestLimit, remainingMs);
  }
}

function omitEstimatedSavings(plan: Record<string, unknown>): Record<string, unknown> {
  const { estimatedSavings: _estimatedSavings, ...safePlan } = plan;
  return safePlan;
}

function compactReadinessReport(report: RecommendationReadinessReport): Readonly<Record<string, unknown>> {
  return {
    summary: report.summary,
    candidates: report.candidates.map((candidate) => ({
      id: candidate.id,
      readiness: candidate.readiness,
      opportunityType: candidate.opportunityType,
      evidenceLevelAllowed: candidate.evidenceLevelAllowed,
      requiresTechnicalValidation: candidate.requiresTechnicalValidation,
      cloudAccountId: candidate.cloudAccountId,
      provider: candidate.provider,
      serviceName: candidate.serviceName,
      ...(candidate.observedCost === undefined ? {} : { observedCost: candidate.observedCost }),
      maxEstimatedMonthlySavings: candidate.maxEstimatedMonthlySavings,
      currency: candidate.currency,
      costEvidenceRefs: candidate.costEvidenceRefs,
      ...(candidate.reviewScope === undefined ? {} : { reviewScope: candidate.reviewScope }),
      ...(candidate.resourceId === undefined ? {} : { resourceId: candidate.resourceId }),
      ...(candidate.cloudResourceId === undefined ? {} : { cloudResourceId: candidate.cloudResourceId }),
      ...(candidate.cloudConnectionId === undefined ? {} : { cloudConnectionId: candidate.cloudConnectionId }),
      ...(candidate.technicalEvidenceRefs.length === 0 ? {} : { technicalEvidenceRefs: candidate.technicalEvidenceRefs }),
      ...(candidate.blockers === undefined ? {} : { blockers: candidate.blockers }),
      ...(candidate.ruleMatches === undefined ? {} : { ruleMatches: candidate.ruleMatches }),
    })),
    blocked: report.blocked.map((candidate) => ({
      id: candidate.id,
      readiness: candidate.readiness,
      opportunityType: candidate.opportunityType,
      cloudAccountId: candidate.cloudAccountId,
      provider: candidate.provider,
      serviceName: candidate.serviceName,
      ...(candidate.observedCost === undefined ? {} : { observedCost: candidate.observedCost }),
      maxEstimatedMonthlySavings: candidate.maxEstimatedMonthlySavings,
      currency: candidate.currency,
      ...(candidate.resourceId === undefined ? {} : { resourceId: candidate.resourceId }),
      ...(candidate.cloudResourceId === undefined ? {} : { cloudResourceId: candidate.cloudResourceId }),
      ...(candidate.blockers === undefined ? {} : { blockers: candidate.blockers }),
    })),
  };
}

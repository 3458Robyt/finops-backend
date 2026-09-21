import type { AiGatewayRequest, AiReasoningEffort, IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import { buildAuditSystemPrompt, compactSnapshot } from './finOpsAiPrompts.js';
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
      maxTokens: 900,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content:
            'Genera hasta 3 recomendaciones FinOps priorizadas en español usando solo los candidatos permitidos. Si solo hay candidatos VALIDATION_ONLY, genera recomendaciones de validacion tecnica previa.',
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

  public generateExecutionPlan(systemPrompt: string): Promise<string> {
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      timeoutMs: Math.min(this.requestPolicy.timeoutMs, 70_000),
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

  public reviseExecutionPlan(systemPrompt: string, requiredChanges: readonly string[]): Promise<string> {
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      timeoutMs: Math.min(this.requestPolicy.timeoutMs, 70_000),
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
            JSON.stringify(requiredChanges),
          ].join('\n'),
        },
      ],
    });
  }

  public async auditArtifact(input: ArtifactAuditInput): Promise<AiAuditReport> {
    const startedAt = Date.now();
    const request: AiGatewayRequest = {
      model: this.auditorModel,
      responseFormat: 'json',
      // The auditor is a mandatory gate, but a failed provider must not turn a
      // recommendation run into a multi-minute retry chain.
      timeoutMs: Math.min(this.requestPolicy.timeoutMs, 50_000),
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
            JSON.stringify(compactSnapshot(input.snapshot)),
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
              : ['Recomendacion original:', JSON.stringify(input.recommendation)]),
            'Artefacto generado:',
            JSON.stringify(input.artifact),
          ].join('\n'),
        },
      ],
    };
    const rawResponse = await this.aiGateway.generateText(request);

    if (input.tenantId !== undefined) {
      await this.traceRecorder.record({
        tenantId: input.tenantId,
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        operation: 'AUDIT',
        model: this.auditorModel,
        startedAt,
        responseText: rawResponse,
      });
    }

    return parseAuditReport(rawResponse);
  }
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

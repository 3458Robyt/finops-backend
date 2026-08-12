import type { AiGatewayRequest, IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { AiAuditReport } from '../../../domain/models/RecommendationExecutionPlan.js';
import { buildAuditSystemPrompt, compactSnapshot } from './finOpsAiPrompts.js';
import { parseAuditReport } from './finOpsAiResponseParser.js';
import type { AiTraceRecorder } from './aiTraceRecorder.js';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type { DeterministicTrendAnalysis } from './DeterministicTrendAnalysis.js';

export interface ArtifactAuditInput {
  readonly artifactType: 'recommendations' | 'execution_plan';
  readonly snapshot: CostAnalyticsSnapshot;
  readonly recommendation?: FinOpsRecommendation;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly artifact: unknown;
  readonly technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot;
  readonly deterministicAnalysis?: DeterministicTrendAnalysis;
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
  ) {}

  public generateRecommendations(systemPrompt: string): Promise<string> {
    return this.aiGateway.generateText({
      responseFormat: 'json',
      temperature: 0.2,
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
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 900,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            'Corrige las recomendaciones usando exactamente estos cambios requeridos por auditoria.',
            'No agregues cuentas, proveedores ni recursos que no esten en el contexto.',
            'Conserva evidence.candidateId, sourceFacts, assumptions y confidence en cada recomendacion.',
            JSON.stringify(requiredChanges, null, 2),
          ].join('\n'),
        },
      ],
    });
  }

  public generateExecutionPlan(systemPrompt: string): Promise<string> {
    return this.aiGateway.generateText({
      model: this.mainModel,
      responseFormat: 'json',
      temperature: 0.2,
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
      temperature: 0.2,
      maxTokens: 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            'Corrige el plan de ejecucion usando exactamente estos cambios requeridos por auditoria.',
            'Mantiene el alcance manual y no prometas ejecucion automatica.',
            JSON.stringify(requiredChanges, null, 2),
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
      temperature: 0,
      maxTokens: 900,
      messages: [
        { role: 'system', content: buildAuditSystemPrompt() },
        {
          role: 'user',
          content: [
            `Audita este artefacto: ${input.artifactType}.`,
            'Contexto autorizado:',
            JSON.stringify(compactSnapshot(input.snapshot), null, 2),
            ...(input.technicalEvidenceSnapshot === undefined
              ? []
              : ['Evidencia tecnica canonica:', JSON.stringify(input.technicalEvidenceSnapshot, null, 2)]),
            ...(input.deterministicAnalysis === undefined
              ? []
              : ['Preanalisis deterministico de tendencias:', JSON.stringify(input.deterministicAnalysis, null, 2)]),
            ...(input.recommendation === undefined
              ? []
              : ['Recomendacion original:', JSON.stringify(input.recommendation, null, 2)]),
            'Artefacto generado:',
            JSON.stringify(input.artifact, null, 2),
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

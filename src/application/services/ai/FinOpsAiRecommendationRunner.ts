import { AiAuditRejectedError, FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { IRecommendationRepository } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { AiTraceRecorder } from './aiTraceRecorder.js';
import { applyAuditEvidence, buildRecommendationDeduplicationKey } from './recommendationEvidence.js';
import { FinOpsArtifactGenerator } from './finOpsArtifactGenerator.js';
import type { FinOpsContextAssembler } from './finOpsContextAssembler.js';
import type { FinOpsAiRecommendationPreparer } from './FinOpsAiRecommendationPreparer.js';
import { toEphemeralRecommendation } from './finOpsAiResponseParser.js';
import type {
  GenerateAiRecommendationsInput,
  GenerateAiRecommendationsResponse,
} from './finOpsAiTypes.js';

/** Runs the evidence-bound recommendation use case behind the public AI facade. */
export class FinOpsAiRecommendationRunner {
  constructor(
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly contextAssembler: FinOpsContextAssembler,
    private readonly artifactGenerator: FinOpsArtifactGenerator,
    private readonly traceRecorder: AiTraceRecorder,
    private readonly preparer: FinOpsAiRecommendationPreparer,
    private readonly mainModel: string,
    private readonly auditorModel: string,
  ) {}

  public async run(input: GenerateAiRecommendationsInput): Promise<GenerateAiRecommendationsResponse> {
    if (input.cloudResourceId !== undefined && input.externalResourceId === undefined) {
      throw new FinOpsBaseError('cloudResourceId requiere externalResourceId para mantener el alcance canónico.', 'VALIDATION_ERROR');
    }

    const prepared = input.prepared ?? await this.preparer.prepare(input);
    const { snapshot, readinessReport, technicalEvidenceSnapshot } = prepared;
    if (readinessReport.candidates.length === 0) {
      return {
        recommendations: [],
        snapshot,
        persisted: input.persist === true,
        analysis: {
          readinessReport,
          ...(technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot }),
          evidenceHash: prepared.evidenceHash,
          generatedCount: 0,
          rejectedCount: 0,
          promptTokenEstimate: 0,
          responseTokenEstimate: 0,
          model: this.mainModel,
          auditorModel: this.auditorModel,
        },
      };
    }

    const assembled = await this.contextAssembler.assembleRecommendationContext({
      tenantId: input.tenantId,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      snapshot,
      ...(input.externalResourceId === undefined ? {} : { externalResourceId: input.externalResourceId }),
      ...(input.cloudResourceId === undefined ? {} : { cloudResourceId: input.cloudResourceId }),
      ...(technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot }),
    });
    const governedSystemPrompt = [
      assembled.systemPrompt,
      'PREANALISIS DETERMINISTICO DE TENDENCIAS (hechos autorizados):',
      JSON.stringify(prepared.deterministicAnalysis, null, 2),
    ].join('\n\n');
    const startedAt = Date.now();

    await input.onStage?.('AI_GENERATION');
    const { drafts, approvedDrafts, auditReport, candidateAudits, firstRawResponse } = await this.artifactGenerator.generateAuditedDrafts(
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

    if (drafts.length > 0 && approvedDrafts.length === 0) {
      throw new AiAuditRejectedError('AI audit rejected recommendation output', {
        diagnosticId: `audit-${input.tenantId}-${Date.now().toString(36)}`,
        audit: {
          ...auditReport,
          generatedCount: drafts.length,
          promptTokenEstimate: estimateTokens(governedSystemPrompt),
          responseTokenEstimate: estimateTokens(firstRawResponse),
          model: this.mainModel,
          auditorModel: this.auditorModel,
          readinessSummary: readinessReport.summary,
          candidates: readinessReport.candidates.map((candidate) => ({
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

    const auditedDrafts = approvedDrafts.map((draft) => ({
      ...applyAuditEvidence(
        draft,
        auditReport,
        assembled.learningContext,
        technicalEvidenceSnapshot,
        input.analysisRunId,
      ),
      deduplicationKey: buildRecommendationDeduplicationKey(draft, snapshot.periodStart, snapshot.periodEnd),
    }));
    const persisted = input.persist === true;
    await input.onStage?.('PERSISTENCE');
    const recommendations = persisted
      ? await this.recommendationRepository.createMany(auditedDrafts)
      : auditedDrafts.map((draft, index) => toEphemeralRecommendation(draft, index));

    await this.traceRecorder.record({
      tenantId: input.tenantId,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      operation: 'RECOMMENDATION',
      model: this.mainModel,
      ...(assembled.builtContext === undefined ? {} : { builtContext: assembled.builtContext }),
      startedAt,
      responseText: firstRawResponse,
    });

    return {
      recommendations,
      snapshot,
      persisted,
      analysis: {
        readinessReport,
        ...(technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot }),
        evidenceHash: prepared.evidenceHash,
        auditReport,
        generatedCount: drafts.length,
        rejectedCount: drafts.length - approvedDrafts.length,
        candidateAudits,
        promptTokenEstimate: estimateTokens(governedSystemPrompt),
        responseTokenEstimate: estimateTokens(firstRawResponse),
        model: this.mainModel,
        auditorModel: this.auditorModel,
      },
    };
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

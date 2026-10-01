import { randomUUID } from 'node:crypto';
import { AiAuditRejectedError, FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { IRecommendationRepository } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { AiTraceRecorder } from './aiTraceRecorder.js';
import { applyAuditEvidence, buildRecommendationDeduplicationKey } from './recommendationEvidence.js';
import { FinOpsArtifactGenerator, type AuditedDraftsResult } from './finOpsArtifactGenerator.js';
import type { FinOpsContextAssembler } from './finOpsContextAssembler.js';
import type { FinOpsAiRecommendationPreparer } from './FinOpsAiRecommendationPreparer.js';
import { readCandidateId } from '../recommendationAnalysisSupport.js';
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
        persisted: false,
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

    let generated: AuditedDraftsResult;
    try {
      await input.onStage?.('AI_GENERATION');
      generated = await this.artifactGenerator.generateAuditedDrafts(
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
        { allowRepair: input.allowRepair ?? true },
      );
    } catch (error) {
      await this.recordFailure(input.tenantId, input.userId, assembled.builtContext, startedAt, error);
      throw error;
    }

    const { drafts, approvedDrafts, auditReport, candidateAudits, firstRawResponse } = generated;

    if (drafts.length === 0) {
      await input.onStage?.('PERSISTENCE');
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
        recommendations: [],
        snapshot,
        persisted: false,
        analysis: {
          readinessReport,
          ...(technicalEvidenceSnapshot === undefined ? {} : { technicalEvidenceSnapshot }),
          evidenceHash: prepared.evidenceHash,
          generatedCount: 0,
          rejectedCount: 0,
          candidateAudits: [],
          promptTokenEstimate: estimateTokens(governedSystemPrompt),
          responseTokenEstimate: estimateTokens(firstRawResponse),
          model: this.mainModel,
          auditorModel: this.auditorModel,
        },
      };
    }

    if (auditReport === undefined) {
      const error = new FinOpsBaseError('AI audit report is missing for generated recommendations', 'AI_AUDIT_ERROR');
      await this.recordFailure(input.tenantId, input.userId, assembled.builtContext, startedAt, error);
      throw error;
    }

    if (drafts.length > 0 && approvedDrafts.length === 0) {
      const rejection = new AiAuditRejectedError('AI audit rejected recommendation output', {
        diagnosticId: randomUUID(),
        audit: {
          ...auditReport,
          generatedCount: drafts.length,
          promptTokenEstimate: estimateTokens(governedSystemPrompt),
          responseTokenEstimate: estimateTokens(firstRawResponse),
          model: this.mainModel,
          auditorModel: this.auditorModel,
          readinessSummary: readinessReport.summary,
          evidenceHash: prepared.evidenceHash,
          candidateAudits: candidateAudits.map(({ audit, draft, deterministicEvidence }) => ({
            ...audit,
            draft,
            ...(deterministicEvidence === undefined ? {} : { deterministicEvidence }),
          })),
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
      await this.recordFailure(input.tenantId, input.userId, assembled.builtContext, startedAt, rejection);
      throw rejection;
    }

    const auditedDrafts = approvedDrafts.map((draft) => {
      const candidateId = readCandidateId(draft.evidence);
      const candidateAudit = candidateAudits.find((item) => (
        item.audit.verdict === 'APPROVED'
        && item.audit.candidateId === candidateId
      ));
      const individualAudit = candidateAudit === undefined
        ? auditReport
        : {
            verdict: candidateAudit.audit.verdict,
            score: candidateAudit.audit.score,
            checks: candidateAudit.audit.checks,
            blockingIssues: candidateAudit.audit.blockingIssues,
            requiredChanges: candidateAudit.audit.requiredChanges,
          };
      const readinessCandidate = readinessReport.candidates.find(
        (candidate) => candidate.id === candidateId,
      );
      return {
        ...applyAuditEvidence(
          draft,
          individualAudit,
          assembled.learningContext,
          technicalEvidenceSnapshot,
          input.analysisRunId,
        ),
        ...(input.persist !== true || readinessCandidate?.costEvidenceScope === undefined
          ? {}
          : { costEvidenceScope: readinessCandidate.costEvidenceScope }),
        deduplicationKey: buildRecommendationDeduplicationKey(draft, snapshot.periodStart, snapshot.periodEnd),
      };
    });
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

  public async generateReviewDrafts(input: {
    readonly tenantId: string;
    readonly userId?: string;
    readonly prepared: import('./finOpsAiTypes.js').PreparedRecommendationAnalysis;
    readonly deadlineAt: number;
    readonly onStage?: GenerateAiRecommendationsInput['onStage'];
  }): Promise<AuditedDraftsResult & { readonly model: string; readonly auditorModel: string }> {
    const prepared = input.prepared;
    const selected = (prepared.readinessReport.reviewCandidates ?? []).slice(0, 5);
    const selectedIds = new Set(selected.map((candidate) => candidate.id));
    const readinessReport = {
      ...prepared.readinessReport,
      candidates: selected,
      blocked: prepared.readinessReport.blocked.filter((candidate) => !selectedIds.has(candidate.id)),
      deferred: [],
      reviewCandidates: [],
    };
    const systemPrompt = buildTechnicalReviewDraftPrompt(selected);
    const startedAt = Date.now();

    try {
      await input.onStage?.('AI_GENERATION');
      const generated = await this.artifactGenerator.generateAuditedReviewDrafts(
        input.tenantId,
        input.userId,
        prepared.snapshot,
        systemPrompt,
        readinessReport,
        prepared.technicalEvidenceSnapshot,
        prepared.deterministicAnalysis,
        input.deadlineAt,
        async () => { await input.onStage?.('AI_AUDIT'); },
      );
      await this.traceRecorder.record({
        tenantId: input.tenantId,
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        operation: 'RECOMMENDATION',
        model: this.mainModel,
        startedAt,
        responseText: generated.firstRawResponse,
      });
      return { ...generated, model: this.mainModel, auditorModel: this.auditorModel };
    } catch (error) {
      try {
        await this.traceRecorder.record({
          tenantId: input.tenantId,
          ...(input.userId === undefined ? {} : { userId: input.userId }),
          operation: 'RECOMMENDATION',
          model: this.mainModel,
          startedAt,
          error,
        });
      } catch {
        // Keep telemetry failures from masking the review-draft failure.
      }
      throw error;
    }
  }

  private async recordFailure(
    tenantId: string,
    userId: string | undefined,
    builtContext: Parameters<AiTraceRecorder['record']>[0]['builtContext'],
    startedAt: number,
    error: unknown,
  ): Promise<void> {
    try {
      await this.traceRecorder.record({
        tenantId,
        ...(userId === undefined ? {} : { userId }),
        operation: 'RECOMMENDATION',
        model: this.mainModel,
        ...(builtContext === undefined ? {} : { builtContext }),
        startedAt,
        error,
      });
    } catch {
      // Telemetry must not replace the provider/audit error returned to the caller.
    }
  }
}

function buildTechnicalReviewDraftPrompt(
  candidates: readonly import('./RecommendationReadinessGate.js').RecommendationOpportunityCandidate[],
): string {
  return [
    'Eres un agente FinOps que redacta BORRADORES DE REVISION TECNICA, no recomendaciones publicables.',
    'Usa solo los candidatos incluidos abajo. Estos recursos tienen costo observado vigente y vínculo de identidad no ambiguo, pero fallaron o no completaron la evidencia técnica necesaria.',
    'Redacta en español una tarjeta breve para que un técnico sepa qué revisar y por qué. Distingue hechos observados de datos faltantes; cita únicamente hechos de sourceFacts, blockers, ruleMatches y evidenceIssues.',
    'No propongas ni instruyas apagar, detener, borrar, redimensionar, cambiar capacidad, ni ejecutar acciones. No inventes CPU, memoria, métricas, causas o permisos. La siguiente acción debe ser una verificación manual y reversible de datos/telemetría.',
    'No afirmes ahorro ni escribas montos, moneda o porcentajes de ahorro. No generes estimatedMonthlySavings positivo ni potentialMonthlySavings. El borrador no modifica ni sustituye la compuerta determinística de publicación.',
    'Devuelve JSON estricto: {"recommendations":[{"cloudAccountId":"...","cloudResourceId":"...","type":"TECHNICAL_VALIDATION_REQUIRED","severity":"LOW|MEDIUM|HIGH","title":"...","description":"...","currency":"...","evidence":{"candidateId":"...","evidenceLevel":"COST_ONLY|COST_AND_USAGE|COST_USAGE_AND_TECHNICAL","sourceFacts":["..."],"assumptions":[],"confidence":0.0,"requiresTechnicalValidation":true}}]}.',
    'Incluye como máximo un borrador por candidato. Omite candidatos sobre los que no puedas redactar un paso de diagnóstico concreto.',
    'Candidatos seleccionados por reglas determinísticas:',
    JSON.stringify(candidates.map((candidate) => ({
      id: candidate.id,
      cloudAccountId: candidate.cloudAccountId,
      provider: candidate.provider,
      serviceName: candidate.serviceName,
      resourceId: candidate.resourceId,
      resourceName: candidate.resourceName,
      cloudResourceId: candidate.cloudResourceId,
      readiness: candidate.readiness,
      observedCost: candidate.observedCost,
      currency: candidate.currency,
      evidenceStrength: candidate.evidenceStrength,
      sourceFacts: candidate.sourceFacts,
      reasons: candidate.reasons,
      blockers: candidate.blockers,
      ruleMatches: candidate.ruleMatches,
      evidenceIssues: candidate.evidenceIssues,
      evidencePeriod: candidate.evidencePeriod,
      metricSummary: candidate.metricSummary,
      technicalEvidenceRefs: candidate.technicalEvidenceRefs,
      costEvidenceRefs: candidate.costEvidenceRefs,
    })), null, 2),
  ].join('\n\n');
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

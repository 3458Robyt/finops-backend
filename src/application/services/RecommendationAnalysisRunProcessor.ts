import { AiAuditRejectedError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { CreateRecommendationInput } from '../../domain/interfaces/IRecommendationRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { IRecommendationAnalysisRunRepository } from '../../domain/interfaces/IRecommendationAnalysisRunRepository.js';
import type { RecommendationAnalysisRun } from '../../domain/models/RecommendationAnalysisRun.js';
import type { FinOpsAiService } from './FinOpsAiService.js';
import { isRecord } from './ai/jsonReadHelpers.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';
import {
  auditCandidateResults,
  auditSummary,
  buildInitialCandidateResults,
  countResources,
  mergePublishedCandidates,
  normalizePeriod,
  readCandidateId,
  safeMessage,
  retryDelayMs,
} from './recommendationAnalysisSupport.js';
import { notifyAnalysisCompletion } from './recommendationAnalysisNotification.js';
import { buildRecommendationDeduplicationKey } from './ai/recommendationEvidence.js';

const maxAnalysisDurationMs = 120_000;

export class RecommendationAnalysisRunProcessor {
  constructor(
    private readonly repository: IRecommendationAnalysisRunRepository,
    private readonly aiService: FinOpsAiService,
    private readonly notificationRepository: INotificationRepository,
    private readonly recommendationRepository?: IRecommendationRepository,
  ) {}

  public async processNext(workerId: string, staleAfterMs = 30 * 60 * 1000): Promise<RecommendationAnalysisRun | null> {
    return runWithDatabaseContext({ workerId, role: 'MASTER_ADMIN' }, async () => {
      const run = await this.repository.claimNext(workerId, new Date(Date.now() - staleAfterMs));
      if (run === null) return null;
      const stageTimer = new AnalysisStageTimer();
      return runWithDatabaseContext(
        { tenantId: run.tenantId, workerId, role: 'MASTER_ADMIN' },
        async () => {
          const startedAt = Date.now();
          try {
            return await this.processRun(run, startedAt, stageTimer);
          } catch (error: unknown) {
            if (error instanceof RecommendationAnalysisCancelledError) {
              return (await this.repository.finalizeCancellation(run.id)) ?? run;
            }
            if (error instanceof AiAuditRejectedError) return this.completeAuditRejection(run, error, startedAt, stageTimer);
            if (error instanceof FinOpsBaseError && error.code === 'VALIDATION_ERROR') {
              return this.repository.complete(run.id, {
                status: 'SKIPPED',
                recommendationsGenerated: 0,
                recommendationsRejected: 0,
                candidateResults: [],
                recommendationLinks: [],
                promptTokenEstimate: 0,
                responseTokenEstimate: 0,
                latencyMs: Date.now() - startedAt,
                stageTimings: stageTimer.snapshot(),
                errorCode: 'INSUFFICIENT_EVIDENCE',
                errorMessage: safeMessage(error),
              });
            }
            return this.repository.recordFailure(run.id, {
              code: error instanceof FinOpsBaseError ? error.code : 'ANALYSIS_PROVIDER_ERROR',
              message: safeMessage(error),
              retryAt: new Date(Date.now() + retryDelayMs(run.attempts)),
              stageTimings: stageTimer.snapshot(),
            });
          }
        },
      );
    });
  }

  private async processRun(
    run: RecommendationAnalysisRun,
    startedAt: number,
    stageTimer: AnalysisStageTimer,
  ): Promise<RecommendationAnalysisRun> {
    await this.ensureActive(run.id, startedAt);
    await this.setStage(run.id, 'SELECTING_DATA', stageTimer);
    const prepared = await this.aiService.prepareRecommendationAnalysis({
      tenantId: run.tenantId,
      ...(run.externalResourceId !== undefined ? { externalResourceId: run.externalResourceId } : {}),
      ...(run.cloudResourceId !== undefined ? { cloudResourceId: run.cloudResourceId } : {}),
    });
    const bounds = normalizePeriod(prepared.snapshot.periodStart, prepared.snapshot.periodEnd);
    const initialCandidateResults = buildInitialCandidateResults(prepared);
    const resourcesEvaluated = countResources(prepared);

    await this.ensureActive(run.id, startedAt);
    await this.setStage(run.id, 'DETERMINISTIC_ANALYSIS', stageTimer);
    await this.repository.savePrepared(run.id, {
      periodStart: bounds.start,
      periodEnd: bounds.end,
      evidenceHash: prepared.evidenceHash,
      snapshot: { costSnapshot: prepared.snapshot, deterministicAnalysis: prepared.deterministicAnalysis },
      ...(prepared.technicalEvidenceSnapshot !== undefined ? { evidenceSnapshot: prepared.technicalEvidenceSnapshot } : {}),
      readinessReport: prepared.readinessReport,
      resourcesEvaluated,
      candidatesFound: initialCandidateResults.length,
      candidatesSkipped: prepared.readinessReport.blocked.length + prepared.readinessReport.deferred.length,
      candidateResults: initialCandidateResults,
      model: prepared.model,
      auditorModel: prepared.auditorModel,
    });

    const equivalent = await this.repository.findEquivalentCompleted(
      run.tenantId, run.scopeKey, bounds.start, bounds.end, prepared.evidenceHash, run.id,
    );
    await this.ensureActive(run.id, startedAt);
    if (equivalent !== null) {
      return this.repository.complete(run.id, {
        status: 'SKIPPED',
        recommendationsGenerated: 0,
        recommendationsRejected: 0,
        candidateResults: initialCandidateResults.map((candidate) => ({
          ...candidate,
          outcome: 'SKIPPED',
          reasons: [`La misma evidencia ya fue analizada en la corrida ${equivalent.id}.`],
        })),
        recommendationLinks: [],
        promptTokenEstimate: 0,
        responseTokenEstimate: 0,
        latencyMs: Date.now() - startedAt,
        stageTimings: stageTimer.snapshot(),
        errorCode: 'UNCHANGED_EVIDENCE',
        errorMessage: 'No se repitió el análisis porque la evidencia no cambió.',
      });
    }

    await this.ensureActive(run.id, startedAt);
    await this.setStage(run.id, 'EVIDENCE_GATE', stageTimer);
    if (prepared.readinessReport.candidates.length === 0) {
      return this.repository.complete(run.id, {
        status: 'SKIPPED',
        recommendationsGenerated: 0,
        recommendationsRejected: 0,
        candidateResults: initialCandidateResults,
        recommendationLinks: [],
        promptTokenEstimate: 0,
        responseTokenEstimate: 0,
        latencyMs: Date.now() - startedAt,
        stageTimings: stageTimer.snapshot(),
        errorCode: 'INSUFFICIENT_EVIDENCE',
        errorMessage: 'No hay evidencia suficiente para generar recomendaciones auditables.',
      });
    }

    const result = await this.aiService.generateRecommendations({
      tenantId: run.tenantId,
      ...(run.requestedByUserId !== undefined ? { userId: run.requestedByUserId } : {}),
      ...(run.externalResourceId !== undefined ? { externalResourceId: run.externalResourceId } : {}),
      ...(run.cloudResourceId !== undefined ? { cloudResourceId: run.cloudResourceId } : {}),
      analysisRunId: run.id,
      allowRepair: false,
      // Keep the provider response ephemeral until the run has crossed the
      // cancellation fence below. Persisting inside FinOpsAiService would
      // publish recommendations while the AI call is still cancellable.
      persist: false,
      prepared,
      onStage: async (stage) => {
        await this.ensureActive(run.id, startedAt);
        await this.setStage(run.id, stage, stageTimer);
        await this.ensureActive(run.id, startedAt);
      },
    });
    await this.ensureActive(run.id, startedAt);
    const recommendationInputs = result.recommendations.map((recommendation) => ({
      tenantId: run.tenantId,
      cloudAccountId: recommendation.cloudAccountId,
      ...(recommendation.cloudResourceId === undefined ? {} : { cloudResourceId: recommendation.cloudResourceId }),
      ...(recommendation.resourceLinkReason === undefined ? {} : { resourceLinkReason: recommendation.resourceLinkReason }),
      deduplicationKey: buildRecommendationDeduplicationKey(
        { ...recommendation, tenantId: run.tenantId },
        prepared.snapshot.periodStart,
        prepared.snapshot.periodEnd,
      ),
      type: recommendation.type,
      origin: recommendation.origin,
      severity: recommendation.severity,
      title: recommendation.title,
      description: recommendation.description,
      evidence: recommendation.evidence,
      ...(recommendation.estimatedMonthlySavings === undefined ? {} : { estimatedMonthlySavings: recommendation.estimatedMonthlySavings }),
      currency: recommendation.currency,
    } satisfies CreateRecommendationInput));
    // The production composition supplies the recommendation port so
    // persistence happens only after the cancellation fence. The fallback is
    // kept for isolated processor tests that provide a pre-persisted fixture.
    const persistedRecommendations = this.recommendationRepository === undefined
      ? result.recommendations
      : await this.recommendationRepository.createMany(recommendationInputs);
    await this.ensureActive(run.id, startedAt);
    const links = persistedRecommendations.map((recommendation) => {
      const candidateId = readCandidateId(recommendation.evidence);
      return {
        recommendationId: recommendation.id,
        ...(candidateId !== undefined ? { candidateId } : {}),
        disposition: recommendation.createdAt.getTime() >= (run.startedAt?.getTime() ?? startedAt) ? 'CREATED' as const : 'REUSED' as const,
      };
    });
    const rejectedCandidateAudits = new Map(
      (result.analysis.candidateAudits ?? [])
        .filter(({ audit }) => audit.verdict !== 'APPROVED')
        .map(({ audit }) => [audit.candidateId ?? `draft-${audit.index}`, [
          ...audit.blockingIssues,
          ...audit.requiredChanges,
          'El auditor IA rechazó este candidato; no se publicó la recomendación.',
        ]]),
    );
    const candidateResults = mergePublishedCandidates(initialCandidateResults, persistedRecommendations.map((recommendation) => {
      const candidateId = readCandidateId(recommendation.evidence);
      return { id: recommendation.id, ...(candidateId !== undefined ? { candidateId } : {}) };
    }), rejectedCandidateAudits);

    const createdRecommendationIds = new Set(links.filter((link) => link.disposition === 'CREATED').map((link) => link.recommendationId));
    const createdRecommendations = persistedRecommendations.filter((item) => createdRecommendationIds.has(item.id));
    const recommendationByCandidate = new Map(
      links
        .filter((link): link is typeof link & { candidateId: string } => link.candidateId !== undefined)
        .map((link) => [link.candidateId, link.recommendationId]),
    );
    const candidateAuditRecords = (result.analysis.candidateAudits ?? []).map(({ audit, draft, deterministicEvidence }) => {
      const candidateId = audit.candidateId ?? `draft-${audit.index}`;
      const recommendationId = recommendationByCandidate.get(candidateId);
      return {
        tenantId: run.tenantId,
        candidateId,
        draftIndex: audit.index,
        ...(recommendationId === undefined ? {} : { recommendationId }),
        ...(deterministicEvidence === undefined ? {} : { deterministicEvidence }),
        draft,
        auditVerdict: audit.verdict,
        auditScore: audit.score,
        auditChecks: audit.checks,
        blockingIssues: audit.blockingIssues,
        requiredChanges: audit.requiredChanges,
        repairAttempt: 0,
        finalDisposition: audit.verdict === 'APPROVED' && recommendationId !== undefined
          ? 'PUBLISHED' as const
          : 'REJECTED' as const,
        model: result.analysis.model,
        auditorModel: result.analysis.auditorModel,
        evidenceHash: prepared.evidenceHash,
      };
    });
    const notificationFailed = await notifyAnalysisCompletion({
      run,
      prepared,
      recommendations: createdRecommendations,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      createdRecommendationIds,
      runs: this.repository,
      notifications: this.notificationRepository,
    });

    await this.ensureActive(run.id, startedAt);
    await this.setStage(run.id, 'NOTIFICATION', stageTimer);
    const rejectedCount = result.analysis.rejectedCount ?? 0;
    return this.repository.complete(run.id, {
      status: notificationFailed || rejectedCount > 0 ? 'PARTIAL' : persistedRecommendations.length > 0 ? 'COMPLETED' : 'SKIPPED',
      recommendationsGenerated: result.analysis.generatedCount,
      recommendationsRejected: rejectedCount,
      candidateResults,
      recommendationLinks: links,
      candidateAudits: candidateAuditRecords,
      promptTokenEstimate: result.analysis.promptTokenEstimate,
      responseTokenEstimate: result.analysis.responseTokenEstimate,
      latencyMs: Date.now() - startedAt,
      stageTimings: stageTimer.snapshot(),
      ...(notificationFailed
        ? { errorCode: 'NOTIFICATION_FAILED', errorMessage: 'Las recomendaciones se publicaron, pero no pudo crearse la notificación.' }
        : rejectedCount > 0
          ? { errorCode: 'AI_PARTIAL_AUDIT', errorMessage: `${rejectedCount} recomendación(es) fueron retenidas por auditoría.` }
        : persistedRecommendations.length === 0
          ? { errorCode: 'NO_NEW_OPPORTUNITIES', errorMessage: 'El análisis no publicó oportunidades nuevas.' }
          : {}),
    });
  }

  private async setStage(
    runId: string,
    stage: Parameters<IRecommendationAnalysisRunRepository['updateStage']>[1],
    stageTimer: AnalysisStageTimer,
  ): Promise<void> {
    stageTimer.start(stage);
    await this.repository.updateStage(runId, stage);
  }

  private async ensureActive(runId: string, startedAt?: number): Promise<void> {
    if (await this.repository.isCancellationRequested(runId)) {
      throw new RecommendationAnalysisCancelledError();
    }
    if (startedAt !== undefined && Date.now() - startedAt > maxAnalysisDurationMs) {
      throw new RecommendationAnalysisTimeoutError();
    }
  }

  private completeAuditRejection(
    run: RecommendationAnalysisRun,
    error: AiAuditRejectedError,
    startedAt: number,
    stageTimer: AnalysisStageTimer,
  ): Promise<RecommendationAnalysisRun> {
    const audit = isRecord(error.audit) ? error.audit : {};
    const reasons = Array.isArray(audit['blockingIssues']) ? audit['blockingIssues'].filter((item): item is string => typeof item === 'string') : ['El auditor rechazó el artefacto generado.'];
    const candidateResults = auditCandidateResults(audit, reasons);
    const summary = auditSummary(audit);
    return this.repository.complete(run.id, {
      status: 'PARTIAL',
      recommendationsGenerated: summary.recommendationsGenerated,
      recommendationsRejected: candidateResults.length,
      candidateResults,
      recommendationLinks: [],
      promptTokenEstimate: summary.promptTokenEstimate,
      responseTokenEstimate: summary.responseTokenEstimate,
      latencyMs: Date.now() - startedAt,
      stageTimings: stageTimer.snapshot(),
      errorCode: 'AI_AUDIT_REJECTED',
      errorMessage: 'El auditor rechazó las recomendaciones generadas; no se publicó ninguna.',
    });
  }
}

class RecommendationAnalysisCancelledError extends Error {}

class RecommendationAnalysisTimeoutError extends FinOpsBaseError {
  constructor() {
    super('El análisis superó el límite de 120 segundos y fue detenido.', 'ANALYSIS_TIMEOUT');
  }
}

class AnalysisStageTimer {
  private activeStage: { readonly stage: string; readonly startedAt: number } | undefined;
  private readonly durations = new Map<string, number>();

  public start(stage: string): void {
    this.finish();
    this.activeStage = { stage, startedAt: Date.now() };
  }

  public snapshot(): Readonly<Record<string, number>> {
    this.finish();
    return Object.fromEntries(this.durations);
  }

  private finish(): void {
    if (this.activeStage === undefined) return;
    const elapsed = Math.max(0, Date.now() - this.activeStage.startedAt);
    this.durations.set(this.activeStage.stage, (this.durations.get(this.activeStage.stage) ?? 0) + elapsed);
    this.activeStage = undefined;
  }
}

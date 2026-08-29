import { AiAuditRejectedError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
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

export class RecommendationAnalysisRunProcessor {
  constructor(
    private readonly repository: IRecommendationAnalysisRunRepository,
    private readonly aiService: FinOpsAiService,
    private readonly notificationRepository: INotificationRepository,
  ) {}

  public async processNext(workerId: string, staleAfterMs = 30 * 60 * 1000): Promise<RecommendationAnalysisRun | null> {
    return runWithDatabaseContext({ workerId, role: 'MASTER_ADMIN' }, async () => {
      const run = await this.repository.claimNext(workerId, new Date(Date.now() - staleAfterMs));
      if (run === null) return null;
      return runWithDatabaseContext(
        { tenantId: run.tenantId, workerId, role: 'MASTER_ADMIN' },
        async () => {
          const startedAt = Date.now();
          try {
            return await this.processRun(run, startedAt);
          } catch (error: unknown) {
            if (error instanceof AiAuditRejectedError) return this.completeAuditRejection(run, error, startedAt);
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
                errorCode: 'INSUFFICIENT_EVIDENCE',
                errorMessage: safeMessage(error),
              });
            }
            return this.repository.recordFailure(run.id, {
              code: error instanceof FinOpsBaseError ? error.code : 'ANALYSIS_PROVIDER_ERROR',
              message: safeMessage(error),
              retryAt: new Date(Date.now() + retryDelayMs(run.attempts)),
            });
          }
        },
      );
    });
  }

  private async processRun(run: RecommendationAnalysisRun, startedAt: number): Promise<RecommendationAnalysisRun> {
    await this.repository.updateStage(run.id, 'SELECTING_DATA');
    const prepared = await this.aiService.prepareRecommendationAnalysis({
      tenantId: run.tenantId,
      ...(run.externalResourceId !== undefined ? { externalResourceId: run.externalResourceId } : {}),
      ...(run.cloudResourceId !== undefined ? { cloudResourceId: run.cloudResourceId } : {}),
    });
    const bounds = normalizePeriod(prepared.snapshot.periodStart, prepared.snapshot.periodEnd);
    const initialCandidateResults = buildInitialCandidateResults(prepared);
    const resourcesEvaluated = countResources(prepared);

    await this.repository.updateStage(run.id, 'DETERMINISTIC_ANALYSIS');
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
        errorCode: 'UNCHANGED_EVIDENCE',
        errorMessage: 'No se repitió el análisis porque la evidencia no cambió.',
      });
    }

    await this.repository.updateStage(run.id, 'EVIDENCE_GATE');
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
      persist: true,
      prepared,
      onStage: (stage) => this.repository.updateStage(run.id, stage),
    });
    const links = result.recommendations.map((recommendation) => {
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
    const candidateResults = mergePublishedCandidates(initialCandidateResults, result.recommendations.map((recommendation) => {
      const candidateId = readCandidateId(recommendation.evidence);
      return { id: recommendation.id, ...(candidateId !== undefined ? { candidateId } : {}) };
    }), rejectedCandidateAudits);

    const createdRecommendationIds = new Set(links.filter((link) => link.disposition === 'CREATED').map((link) => link.recommendationId));
    const createdRecommendations = result.recommendations.filter((item) => createdRecommendationIds.has(item.id));
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

    const rejectedCount = result.analysis.rejectedCount ?? 0;
    return this.repository.complete(run.id, {
      status: notificationFailed || rejectedCount > 0 ? 'PARTIAL' : result.recommendations.length > 0 ? 'COMPLETED' : 'SKIPPED',
      recommendationsGenerated: result.analysis.generatedCount,
      recommendationsRejected: rejectedCount,
      candidateResults,
      recommendationLinks: links,
      candidateAudits: candidateAuditRecords,
      promptTokenEstimate: result.analysis.promptTokenEstimate,
      responseTokenEstimate: result.analysis.responseTokenEstimate,
      latencyMs: Date.now() - startedAt,
      ...(notificationFailed
        ? { errorCode: 'NOTIFICATION_FAILED', errorMessage: 'Las recomendaciones se publicaron, pero no pudo crearse la notificación.' }
        : rejectedCount > 0
          ? { errorCode: 'AI_PARTIAL_AUDIT', errorMessage: `${rejectedCount} recomendación(es) fueron retenidas por auditoría.` }
        : result.recommendations.length === 0
          ? { errorCode: 'NO_NEW_OPPORTUNITIES', errorMessage: 'El análisis no publicó oportunidades nuevas.' }
          : {}),
    });
  }

  private completeAuditRejection(run: RecommendationAnalysisRun, error: AiAuditRejectedError, startedAt: number): Promise<RecommendationAnalysisRun> {
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
      errorCode: 'AI_AUDIT_REJECTED',
      errorMessage: 'El auditor rechazó las recomendaciones generadas; no se publicó ninguna.',
    });
  }
}

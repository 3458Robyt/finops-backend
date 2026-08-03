import { AiAuditRejectedError, AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IRecommendationAnalysisRunRepository } from '../../domain/interfaces/IRecommendationAnalysisRunRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type {
  RecommendationAnalysisCandidateResult,
  RecommendationAnalysisRun,
} from '../../domain/models/RecommendationAnalysisRun.js';
import type { FinOpsAiService } from './FinOpsAiService.js';
import type { PreparedRecommendationAnalysis } from './ai/finOpsAiTypes.js';
import type { RecommendationOpportunityCandidate } from './ai/RecommendationReadinessGate.js';
import { isRecord } from './ai/jsonReadHelpers.js';
import { runWithDatabaseContext } from '../../infrastructure/database/tenantContext.js';

const managerRoles = new Set<AuthContext['role']>([
  'MASTER_ADMIN',
  'OPERATOR_ADMIN',
  'ADMIN',
  'FINOPS_TECHNICIAN',
]);

export class RecommendationAnalysisService {
  public constructor(
    private readonly repository: IRecommendationAnalysisRunRepository,
    private readonly aiService: FinOpsAiService,
    private readonly notificationRepository: INotificationRepository,
  ) {}

  public async queue(
    actor: AuthContext,
    input: { readonly externalResourceId?: string; readonly cloudResourceId?: string },
  ): Promise<{ readonly run: RecommendationAnalysisRun; readonly reused: boolean }> {
    this.requireManager(actor);
    const externalResourceId = input.externalResourceId?.trim();
    const cloudResourceId = input.cloudResourceId?.trim();
    if (input.externalResourceId !== undefined && externalResourceId === '') {
      throw new FinOpsBaseError('El identificador del recurso no puede estar vacío.', 'VALIDATION_ERROR');
    }
    if (input.cloudResourceId !== undefined && cloudResourceId === '') {
      throw new FinOpsBaseError('El identificador canónico del recurso no puede estar vacío.', 'VALIDATION_ERROR');
    }
    if (cloudResourceId !== undefined && externalResourceId === undefined) {
      throw new FinOpsBaseError('El cloudResourceId requiere externalResourceId para mantener el alcance canónico.', 'VALIDATION_ERROR');
    }

    return this.repository.queue({
      tenantId: actor.tenantId,
      requestedByUserId: actor.userId,
      trigger: 'MANUAL',
      scope: externalResourceId === undefined && cloudResourceId === undefined ? 'TENANT' : 'RESOURCE',
      ...(externalResourceId !== undefined ? { externalResourceId } : {}),
      ...(cloudResourceId !== undefined ? { cloudResourceId } : {}),
    });
  }

  public async preview(
    actor: AuthContext,
    input: { readonly externalResourceId?: string; readonly cloudResourceId?: string },
  ): Promise<{
    readonly scope: 'TENANT' | 'RESOURCE';
    readonly externalResourceId?: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly evidenceHash: string;
    readonly resourcesEvaluated: number;
    readonly candidatesFound: number;
    readonly candidatesSkipped: number;
    readonly readinessReport: PreparedRecommendationAnalysis['readinessReport'];
  }> {
    const externalResourceId = input.externalResourceId?.trim();
    const cloudResourceId = input.cloudResourceId?.trim();
    if (cloudResourceId !== undefined && cloudResourceId !== '' && (externalResourceId === undefined || externalResourceId === '')) {
      throw new FinOpsBaseError('El cloudResourceId requiere externalResourceId para mantener el alcance canónico.', 'VALIDATION_ERROR');
    }
    const prepared = await this.aiService.prepareRecommendationAnalysis({
      tenantId: actor.tenantId,
      ...(externalResourceId !== undefined && externalResourceId !== ''
        ? { externalResourceId }
        : {}),
      ...(cloudResourceId !== undefined && cloudResourceId !== '' ? { cloudResourceId } : {}),
    });
    const period = normalizePeriod(prepared.snapshot.periodStart, prepared.snapshot.periodEnd);
    return {
      scope: externalResourceId === undefined || externalResourceId === '' ? 'TENANT' : 'RESOURCE',
      ...(externalResourceId !== undefined && externalResourceId !== ''
        ? { externalResourceId }
        : {}),
      periodStart: period.start,
      periodEnd: period.end,
      evidenceHash: prepared.evidenceHash,
      resourcesEvaluated: countResources(prepared),
      candidatesFound: countCandidates(prepared),
      candidatesSkipped: prepared.readinessReport.blocked.length + prepared.readinessReport.deferred.length,
      readinessReport: prepared.readinessReport,
    };
  }

  public list(actor: AuthContext, limit?: number): Promise<RecommendationAnalysisRun[]> {
    return this.repository.listByTenant(actor.tenantId, limit);
  }

  public get(actor: AuthContext, runId: string): Promise<RecommendationAnalysisRun | null> {
    return this.repository.findById(actor.tenantId, runId);
  }

  public async cancel(actor: AuthContext, runId: string): Promise<RecommendationAnalysisRun> {
    this.requireManager(actor);
    const run = await this.repository.cancelPending(actor.tenantId, runId);
    if (run === null) {
      throw new FinOpsBaseError(
        'La corrida no existe o ya no puede cancelarse porque dejó de estar pendiente.',
        'NOT_FOUND',
      );
    }
    return run;
  }

  public async retry(actor: AuthContext, runId: string): Promise<RecommendationAnalysisRun> {
    this.requireManager(actor);
    const run = await this.repository.retryFailed(actor.tenantId, runId, actor.userId);
    if (run === null) {
      throw new FinOpsBaseError(
        'La corrida no existe o no está en estado fallido.',
        'NOT_FOUND',
      );
    }
    return run;
  }

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
            if (error instanceof AiAuditRejectedError) {
              return this.completeAuditRejection(run, error, startedAt);
            }
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

  private async processRun(
    run: RecommendationAnalysisRun,
    startedAt: number,
  ): Promise<RecommendationAnalysisRun> {
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
      snapshot: {
        costSnapshot: prepared.snapshot,
        deterministicAnalysis: prepared.deterministicAnalysis,
      },
      ...(prepared.technicalEvidenceSnapshot !== undefined
        ? { evidenceSnapshot: prepared.technicalEvidenceSnapshot }
        : {}),
      readinessReport: prepared.readinessReport,
      resourcesEvaluated,
      candidatesFound: initialCandidateResults.length,
      candidatesSkipped: prepared.readinessReport.blocked.length + prepared.readinessReport.deferred.length,
      candidateResults: initialCandidateResults,
      model: prepared.model,
      auditorModel: prepared.auditorModel,
    });

    const equivalent = await this.repository.findEquivalentCompleted(
      run.tenantId,
      run.scopeKey,
      bounds.start,
      bounds.end,
      prepared.evidenceHash,
      run.id,
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
        disposition: recommendation.createdAt.getTime() >= (run.startedAt?.getTime() ?? startedAt)
          ? 'CREATED' as const
          : 'REUSED' as const,
      };
    });
    const candidateResults = mergePublishedCandidates(
      initialCandidateResults,
      result.recommendations.map((recommendation) => {
        const candidateId = readCandidateId(recommendation.evidence);
        return {
          id: recommendation.id,
          ...(candidateId !== undefined ? { candidateId } : {}),
        };
      }),
    );

    let notificationFailed = false;
    const createdRecommendationIds = new Set(
      links.filter((link) => link.disposition === 'CREATED').map((link) => link.recommendationId),
    );
    const createdRecommendations = result.recommendations.filter((item) => createdRecommendationIds.has(item.id));
    if (run.requestedByUserId !== undefined && createdRecommendations.length > 0) {
      await this.repository.updateStage(run.id, 'NOTIFICATION');
      try {
        await this.notificationRepository.create({
          tenantId: run.tenantId,
          userId: run.requestedByUserId,
          type: 'RECOMMENDATION_ANALYSIS_COMPLETED',
          title: 'Nuevas oportunidades FinOps',
          message: `El análisis publicó ${createdRecommendations.length} recomendación(es) auditada(s).`,
          estimatedMonthlySavings: createdRecommendations.reduce(
            (sum, item) => sum + (item.estimatedMonthlySavings ?? 0),
            0,
          ),
          currency: createdRecommendations[0]?.currency ?? prepared.snapshot.currency,
          periodStart: bounds.start,
          periodEnd: bounds.end,
          metadata: { analysisRunId: run.id, recommendationIds: [...createdRecommendationIds] },
        });
      } catch {
        notificationFailed = true;
      }
    }

    return this.repository.complete(run.id, {
      status: notificationFailed
        ? 'PARTIAL'
        : result.recommendations.length > 0
          ? 'COMPLETED'
          : 'SKIPPED',
      recommendationsGenerated: result.analysis.generatedCount,
      recommendationsRejected: 0,
      candidateResults,
      recommendationLinks: links,
      promptTokenEstimate: result.analysis.promptTokenEstimate,
      responseTokenEstimate: result.analysis.responseTokenEstimate,
      latencyMs: Date.now() - startedAt,
      ...(notificationFailed
        ? {
            errorCode: 'NOTIFICATION_FAILED',
            errorMessage: 'Las recomendaciones se publicaron, pero no pudo crearse la notificación.',
          }
        : result.recommendations.length === 0
          ? {
              errorCode: 'NO_NEW_OPPORTUNITIES',
              errorMessage: 'El análisis no publicó oportunidades nuevas.',
            }
          : {}),
    });
  }

  private async completeAuditRejection(
    run: RecommendationAnalysisRun,
    error: AiAuditRejectedError,
    startedAt: number,
  ): Promise<RecommendationAnalysisRun> {
    const audit = isRecord(error.audit) ? error.audit : {};
    const reasons = Array.isArray(audit['blockingIssues'])
      ? audit['blockingIssues'].filter((item): item is string => typeof item === 'string')
      : ['El auditor rechazó el artefacto generado.'];
    const allowed = Array.isArray(audit['candidates'])
      ? audit['candidates'].filter(isCandidate)
      : [];
    const candidateResults = [
      ...allowed.map((candidate) => ({
        ...toCandidateResult(candidate, 'REJECTED' as const),
        reasons,
      })),
    ];

    return this.repository.complete(run.id, {
      status: 'PARTIAL',
      recommendationsGenerated: readNonNegativeInteger(audit['generatedCount']),
      recommendationsRejected: allowed.length,
      candidateResults,
      recommendationLinks: [],
      promptTokenEstimate: readNonNegativeInteger(audit['promptTokenEstimate']),
      responseTokenEstimate: readNonNegativeInteger(audit['responseTokenEstimate']),
      latencyMs: Date.now() - startedAt,
      errorCode: 'AI_AUDIT_REJECTED',
      errorMessage: 'El auditor rechazó las recomendaciones generadas; no se publicó ninguna.',
    });
  }

  private requireManager(actor: AuthContext): void {
    if (!managerRoles.has(actor.role)) {
      throw new AuthorizationError('No tienes permiso para iniciar o modificar corridas de análisis.');
    }
  }
}

function buildInitialCandidateResults(
  prepared: PreparedRecommendationAnalysis,
): RecommendationAnalysisCandidateResult[] {
  return [
    ...prepared.readinessReport.candidates.map((candidate) => toCandidateResult(candidate, 'ELIGIBLE')),
    ...prepared.readinessReport.blocked.map((candidate) => toCandidateResult(candidate, 'SKIPPED')),
    ...prepared.readinessReport.deferred.map((candidate) => toCandidateResult(candidate, 'SKIPPED')),
  ];
}

function countCandidates(prepared: PreparedRecommendationAnalysis): number {
  return prepared.readinessReport.candidates.length
    + prepared.readinessReport.blocked.length
    + prepared.readinessReport.deferred.length;
}

function toCandidateResult(
  candidate: RecommendationOpportunityCandidate,
  outcome: RecommendationAnalysisCandidateResult['outcome'],
): RecommendationAnalysisCandidateResult {
  return {
    candidateId: candidate.id,
    ...(candidate.resourceId !== undefined ? { resourceId: candidate.resourceId } : {}),
    readiness: candidate.readiness,
    outcome,
    reasons: candidate.reasons,
  };
}

function mergePublishedCandidates(
  initial: readonly RecommendationAnalysisCandidateResult[],
  published: readonly { readonly id: string; readonly candidateId?: string }[],
): RecommendationAnalysisCandidateResult[] {
  const byCandidate = new Map(
    published
      .filter((item): item is { id: string; candidateId: string } => item.candidateId !== undefined)
      .map((item) => [item.candidateId, item.id]),
  );
  return initial.map((candidate) => {
    if (candidate.outcome === 'SKIPPED') return candidate;
    const recommendationId = byCandidate.get(candidate.candidateId);
    return recommendationId === undefined
      ? {
          ...candidate,
          outcome: 'SKIPPED',
          reasons: ['El generador no publicó una recomendación para este candidato.'],
        }
      : { ...candidate, outcome: 'PUBLISHED', recommendationId };
  });
}

function countResources(prepared: PreparedRecommendationAnalysis): number {
  const ids = new Set<string>();
  for (const candidate of [...prepared.readinessReport.candidates, ...prepared.readinessReport.blocked]) {
    if (candidate.resourceId !== undefined) ids.add(candidate.resourceId);
  }
  for (const resource of prepared.technicalEvidenceSnapshot?.resources ?? []) {
    ids.add(resource.externalResourceId);
  }
  return ids.size > 0 ? ids.size : prepared.snapshot.topResources.length;
}

function normalizePeriod(periodStart: string, periodEnd: string): { start: Date; end: Date } {
  const start = new Date(periodStart);
  const parsedEnd = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(parsedEnd.getTime())) {
    throw new FinOpsBaseError('El período analítico disponible no es válido.', 'VALIDATION_ERROR');
  }
  return { start, end: parsedEnd > start ? parsedEnd : new Date(start.getTime() + 1) };
}

function readCandidateId(evidence: unknown): string | undefined {
  if (!isRecord(evidence)) return undefined;
  const candidateId = evidence['candidateId'];
  return typeof candidateId === 'string' && candidateId.trim() !== '' ? candidateId : undefined;
}

function isCandidate(value: unknown): value is RecommendationOpportunityCandidate {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['readiness'] === 'string'
    && Array.isArray(value['reasons']);
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function retryDelayMs(attempts: number): number {
  return Math.min(15_000 * Math.max(attempts, 1), 60_000);
}

function safeMessage(error: unknown): string {
  if (error instanceof FinOpsBaseError && error.code === 'VALIDATION_ERROR') return error.message;
  return 'El análisis no pudo completarse por un fallo temporal. Se reintentará de forma controlada.';
}

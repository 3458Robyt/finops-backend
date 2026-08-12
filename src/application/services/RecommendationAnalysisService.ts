import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IRecommendationAnalysisRunRepository } from '../../domain/interfaces/IRecommendationAnalysisRunRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { RecommendationAnalysisRun } from '../../domain/models/RecommendationAnalysisRun.js';
import type { FinOpsAiService } from './FinOpsAiService.js';
import type { PreparedRecommendationAnalysis } from './ai/finOpsAiTypes.js';
import { requirePermission } from '../../domain/security/AuthorizationPolicy.js';
import { RecommendationAnalysisRunProcessor } from './RecommendationAnalysisRunProcessor.js';
import { countCandidates, countResources, normalizePeriod } from './recommendationAnalysisSupport.js';

export class RecommendationAnalysisService {
  private readonly processor: RecommendationAnalysisRunProcessor;

  public constructor(
    private readonly repository: IRecommendationAnalysisRunRepository,
    private readonly aiService: FinOpsAiService,
    notificationRepository: INotificationRepository,
  ) {
    this.processor = new RecommendationAnalysisRunProcessor(repository, aiService, notificationRepository);
  }

  public async queue(actor: AuthContext, input: { readonly externalResourceId?: string; readonly cloudResourceId?: string }): Promise<{ readonly run: RecommendationAnalysisRun; readonly reused: boolean }> {
    this.requireManager(actor);
    const externalResourceId = input.externalResourceId?.trim();
    const cloudResourceId = input.cloudResourceId?.trim();
    if (input.externalResourceId !== undefined && externalResourceId === '') throw new FinOpsBaseError('El identificador del recurso no puede estar vacío.', 'VALIDATION_ERROR');
    if (input.cloudResourceId !== undefined && cloudResourceId === '') throw new FinOpsBaseError('El identificador canónico del recurso no puede estar vacío.', 'VALIDATION_ERROR');
    if (cloudResourceId !== undefined && externalResourceId === undefined) throw new FinOpsBaseError('El cloudResourceId requiere externalResourceId para mantener el alcance canónico.', 'VALIDATION_ERROR');
    return this.repository.queue({
      tenantId: actor.tenantId,
      requestedByUserId: actor.userId,
      trigger: 'MANUAL',
      scope: externalResourceId === undefined && cloudResourceId === undefined ? 'TENANT' : 'RESOURCE',
      ...(externalResourceId !== undefined ? { externalResourceId } : {}),
      ...(cloudResourceId !== undefined ? { cloudResourceId } : {}),
    });
  }

  public async preview(actor: AuthContext, input: { readonly externalResourceId?: string; readonly cloudResourceId?: string }): Promise<{
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
      ...(externalResourceId !== undefined && externalResourceId !== '' ? { externalResourceId } : {}),
      ...(cloudResourceId !== undefined && cloudResourceId !== '' ? { cloudResourceId } : {}),
    });
    const period = normalizePeriod(prepared.snapshot.periodStart, prepared.snapshot.periodEnd);
    return {
      scope: externalResourceId === undefined || externalResourceId === '' ? 'TENANT' : 'RESOURCE',
      ...(externalResourceId !== undefined && externalResourceId !== '' ? { externalResourceId } : {}),
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
    if (run === null) throw new FinOpsBaseError('La corrida no existe o ya no puede cancelarse porque dejó de estar pendiente.', 'NOT_FOUND');
    return run;
  }

  public async retry(actor: AuthContext, runId: string): Promise<RecommendationAnalysisRun> {
    this.requireManager(actor);
    const run = await this.repository.retryFailed(actor.tenantId, runId, actor.userId);
    if (run === null) throw new FinOpsBaseError('La corrida no existe o no está en estado fallido.', 'NOT_FOUND');
    return run;
  }

  public processNext(workerId: string, staleAfterMs = 30 * 60 * 1000): Promise<RecommendationAnalysisRun | null> {
    return this.processor.processNext(workerId, staleAfterMs);
  }

  private requireManager(actor: AuthContext): void {
    requirePermission(actor.role, 'RECOMMENDATION_GENERATE', 'No tienes permiso para iniciar o modificar corridas de análisis.');
  }
}

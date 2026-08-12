import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IRecommendationAnalysisRunRepository } from '../../domain/interfaces/IRecommendationAnalysisRunRepository.js';
import type { RecommendationAnalysisRun } from '../../domain/models/RecommendationAnalysisRun.js';
import type { PreparedRecommendationAnalysis } from './ai/finOpsAiTypes.js';

export async function notifyAnalysisCompletion(input: {
  readonly run: RecommendationAnalysisRun;
  readonly prepared: PreparedRecommendationAnalysis;
  readonly recommendations: readonly {
    readonly id: string;
    readonly estimatedMonthlySavings?: number;
    readonly currency: string;
  }[];
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly createdRecommendationIds: ReadonlySet<string>;
  readonly runs: IRecommendationAnalysisRunRepository;
  readonly notifications: INotificationRepository;
}): Promise<boolean> {
  if (input.run.requestedByUserId === undefined || input.recommendations.length === 0) return false;
  await input.runs.updateStage(input.run.id, 'NOTIFICATION');
  try {
    await input.notifications.create({
      tenantId: input.run.tenantId,
      userId: input.run.requestedByUserId,
      type: 'RECOMMENDATION_ANALYSIS_COMPLETED',
      title: 'Nuevas oportunidades FinOps',
      message: `El análisis publicó ${input.recommendations.length} recomendación(es) auditada(s).`,
      estimatedMonthlySavings: input.recommendations.reduce((sum, item) => sum + (item.estimatedMonthlySavings ?? 0), 0),
      currency: input.recommendations[0]?.currency ?? input.prepared.snapshot.currency,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      metadata: { analysisRunId: input.run.id, recommendationIds: [...input.createdRecommendationIds] },
    });
    return false;
  } catch {
    return true;
  }
}

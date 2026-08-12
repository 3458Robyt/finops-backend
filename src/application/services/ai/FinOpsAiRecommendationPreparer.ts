import { createHash } from 'node:crypto';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { ICostAnalyticsRepository } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { buildDeterministicTrendAnalysis } from './DeterministicTrendAnalysis.js';
import type { FinOpsContextAssembler } from './finOpsContextAssembler.js';
import type { GenerateAiRecommendationsInput, PreparedRecommendationAnalysis } from './finOpsAiTypes.js';

/** Builds the canonical evidence package used by recommendation generation and audit. */
export class FinOpsAiRecommendationPreparer {
  constructor(
    private readonly analyticsRepository: ICostAnalyticsRepository,
    private readonly contextAssembler: FinOpsContextAssembler,
    private readonly mainModel: string,
    private readonly auditorModel: string,
  ) {}

  public async prepare(
    input: Pick<GenerateAiRecommendationsInput, 'tenantId' | 'externalResourceId' | 'cloudResourceId'>,
  ): Promise<PreparedRecommendationAnalysis> {
    if (input.cloudResourceId !== undefined && input.externalResourceId === undefined) {
      throw new FinOpsBaseError('cloudResourceId requiere externalResourceId para mantener el alcance canónico.', 'VALIDATION_ERROR');
    }

    const tenantSnapshot = await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const snapshot = input.externalResourceId === undefined
      ? tenantSnapshot
      : this.scopeSnapshotToResource(tenantSnapshot, input.externalResourceId);
    const preparedEvidence = await this.contextAssembler.prepareRecommendationEvidence({
      tenantId: input.tenantId,
      snapshot,
      ...(input.externalResourceId !== undefined ? { externalResourceId: input.externalResourceId } : {}),
      ...(input.cloudResourceId !== undefined ? { cloudResourceId: input.cloudResourceId } : {}),
    });
    const periodEnd = new Date(snapshot.periodEnd);
    const periodFrom = new Date(periodEnd);
    periodFrom.setUTCMonth(periodFrom.getUTCMonth() - 6);
    const trendFilters = {
      from: periodFrom,
      to: periodEnd,
      ...(input.externalResourceId !== undefined
        ? { groupBy: 'resource' as const }
        : { groupBy: 'service' as const }),
    };
    const [allCostSeries, allUsageSeries] = await Promise.all([
      this.analyticsRepository.getMonthlyCostSeries(input.tenantId, trendFilters),
      this.analyticsRepository.getMonthlyUsageSeries(input.tenantId, trendFilters),
    ]);
    const costSeries = input.externalResourceId === undefined
      ? allCostSeries
      : allCostSeries.filter((point) => point.resourceId === input.externalResourceId);
    const usageSeries = input.externalResourceId === undefined
      ? allUsageSeries
      : allUsageSeries.filter((point) => point.resourceId === input.externalResourceId);
    const deterministicAnalysis = buildDeterministicTrendAnalysis(costSeries, usageSeries);
    const evidenceHash = createHash('sha256').update(JSON.stringify({
      snapshot,
      technicalEvidenceHash: preparedEvidence.technicalEvidenceSnapshot?.hash ?? null,
      deterministicAnalysis,
    })).digest('hex');

    return {
      snapshot,
      readinessReport: preparedEvidence.readinessReport,
      ...(preparedEvidence.technicalEvidenceSnapshot !== undefined
        ? { technicalEvidenceSnapshot: preparedEvidence.technicalEvidenceSnapshot }
        : {}),
      evidenceHash,
      deterministicAnalysis,
      model: this.mainModel,
      auditorModel: this.auditorModel,
    };
  }

  private scopeSnapshotToResource(
    snapshot: import('../../../domain/interfaces/ICostAnalyticsRepository.js').CostAnalyticsSnapshot,
    externalResourceId: string,
  ): import('../../../domain/interfaces/ICostAnalyticsRepository.js').CostAnalyticsSnapshot {
    const topResources = snapshot.topResources.filter((resource) => resource.resourceId === externalResourceId);
    if (topResources.length === 0) {
      throw new FinOpsBaseError('No existe evidencia de costo para el recurso solicitado', 'VALIDATION_ERROR');
    }

    const totalCost = topResources.reduce((sum, resource) => sum + resource.totalCost, 0);
    const metricCount = topResources.reduce((sum, resource) => sum + resource.metricCount, 0);
    const { topUsage: _topUsage, usageInsights: _usageInsights, anomalies: _anomalies, forecasts: _forecasts, ...base } = snapshot;
    return {
      ...base,
      totalCost,
      metricCount,
      providers: snapshot.providers.filter((provider) => provider.provider === topResources[0]!.provider),
      accounts: snapshot.accounts.filter((account) => account.provider === topResources[0]!.provider),
      services: snapshot.services.filter((service) => (
        service.provider === topResources[0]!.provider && service.serviceName === topResources[0]!.serviceName
      )),
      environments: [],
      topResources,
      topUsage: (snapshot.topUsage ?? []).filter((usage) => (
        usage.provider === topResources[0]!.provider && usage.serviceName === topResources[0]!.serviceName
      )),
    };
  }
}

import { createHash } from 'node:crypto';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { CostAnalyticsSnapshot, ICostAnalyticsRepository } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
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

    const tenantSnapshot = input.externalResourceId === undefined
      ? undefined
      : await this.analyticsRepository.getLatestTenantSnapshot(input.tenantId);
    const snapshot = input.externalResourceId === undefined
      ? await selectMovingRecommendationSnapshot(this.analyticsRepository, input.tenantId)
      : this.scopeSnapshotToResource(tenantSnapshot!, input.externalResourceId, input.cloudResourceId);
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
      recommendationPipelineVersion: 2,
      snapshot,
      readinessReport: preparedEvidence.readinessReport,
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
    snapshot: CostAnalyticsSnapshot,
    externalResourceId: string,
    cloudResourceId?: string,
  ): CostAnalyticsSnapshot {
    const topResources = snapshot.topResources.filter((resource) => resource.resourceId === externalResourceId
      && (cloudResourceId === undefined || resource.cloudResourceId === cloudResourceId));
    if (topResources.length === 0) {
      throw new FinOpsBaseError('No existe evidencia de costo para el recurso solicitado', 'VALIDATION_ERROR');
    }

    const totalCost = topResources.reduce((sum, resource) => sum + resource.totalCost, 0);
    const metricCount = topResources.reduce((sum, resource) => sum + resource.metricCount, 0);
    const { topUsage: _topUsage, usageInsights: _usageInsights, anomalies: _anomalies, forecasts: _forecasts, ...base } = snapshot;
    // Legacy fixtures and imported snapshots may not carry account identity on
    // each resource. Only use the fallback when the tenant has one account;
    // multiple accounts must remain explicitly linked to avoid cross-account
    // evidence.
    const accountId = topResources[0]!.cloudAccountId
      ?? (snapshot.accounts.length === 1 ? snapshot.accounts[0]?.cloudAccountId : undefined);
    return {
      ...base,
      totalCost,
      metricCount,
      providers: snapshot.providers.filter((provider) => provider.provider === topResources[0]!.provider),
      accounts: accountId === undefined
        ? []
        : snapshot.accounts.filter((account) => account.cloudAccountId === accountId),
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

const recommendationWindowDays = 30;

async function selectMovingRecommendationSnapshot(
  repository: ICostAnalyticsRepository,
  tenantId: string,
  latest?: CostAnalyticsSnapshot,
): Promise<CostAnalyticsSnapshot> {
  const observedThrough = repository.getLatestObservedThrough !== undefined
    ? await repository.getLatestObservedThrough(tenantId)
    : latest?.observedThrough === undefined
      ? undefined
      : new Date(latest.observedThrough);

  if (repository.getTenantSnapshotForPeriod === undefined || observedThrough === undefined) {
    return latest ?? repository.getLatestTenantSnapshot(tenantId);
  }

  if (Number.isNaN(observedThrough.getTime())) {
    return latest ?? repository.getLatestTenantSnapshot(tenantId);
  }

  const periodEnd = new Date(Math.min(observedThrough.getTime(), Date.now()));
  const periodStart = new Date(periodEnd.getTime() - recommendationWindowDays * 24 * 60 * 60 * 1000);
  if (periodEnd <= periodStart) return latest ?? repository.getLatestTenantSnapshot(tenantId);

  return repository.getTenantSnapshotForPeriod(tenantId, periodStart, periodEnd);
}

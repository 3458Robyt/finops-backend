import type { ICostAnalyticsRepository } from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type { IExecutiveSummaryService, ExecutiveSummary } from '../../domain/interfaces/IExecutiveSummaryService.js';
import type { IBudgetRepository } from '../../domain/interfaces/IBudgetRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { IResourceLinkageReadinessRepository } from '../../domain/interfaces/IResourceLinkageReadinessRepository.js';
import type { IValueRealizationRepository } from '../../domain/interfaces/IValueRealizationRepository.js';
import type { CostAnalyticsService } from './CostAnalyticsService.js';

export class ExecutiveSummaryService implements IExecutiveSummaryService {
  constructor(
    private readonly analyticsRepository: ICostAnalyticsRepository,
    private readonly analyticsService: CostAnalyticsService,
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly valueRealizationRepository: IValueRealizationRepository,
    private readonly budgetRepository: IBudgetRepository,
    private readonly linkageRepository: IResourceLinkageReadinessRepository,
  ) {}

  public async getSummary(tenantId: string, now = new Date()): Promise<ExecutiveSummary> {
    const filters = { tenantId };
    const periodStart = startOfMonth(now);
    const [snapshot, scenarios, series, recommendations, realization, readiness, budgets] = await Promise.all([
      this.analyticsRepository.getLatestTenantSnapshot(tenantId),
      this.analyticsService.getForecastScenarios(filters),
      this.analyticsRepository.getMonthlyCostSeries(tenantId, { groupBy: 'service' }),
      this.recommendationRepository.findByTenant({ tenantId }),
      this.valueRealizationRepository.getSummary(filters),
      this.linkageRepository.getForTenant(tenantId, 50),
      this.budgetRepository.list({ tenantId, periodStart, status: 'ACTIVE' }),
    ]);
    const budgetRows = await Promise.all(budgets.map(async (budget) => ({
      budget,
      actual: await this.budgetRepository.getActualCost(budget),
      forecast: await this.budgetRepository.getForecastCost(budget),
    })));
    const currentTrend = aggregateLatestPeriods(series);
    const active = recommendations.filter((item) => item.status === 'PENDING' || item.status === 'APPROVED');
    const potentialByCurrency: Record<string, number> = {};
    for (const recommendation of active) {
      const amount = recommendation.estimatedMonthlySavings ?? 0;
      if (amount > 0) potentialByCurrency[recommendation.currency] = (potentialByCurrency[recommendation.currency] ?? 0) + amount;
    }

    return {
      tenantId,
      generatedAt: now,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
      totalCost: snapshot.totalCost,
      currency: snapshot.currency,
      ...(currentTrend.previous !== undefined ? { previousPeriodCost: currentTrend.previous } : {}),
      ...(currentTrend.percent !== undefined ? { variationPercent: currentTrend.percent } : {}),
      forecastScenarios: scenarios,
      opportunities: {
        count: active.length,
        potentialByCurrency,
        top: active
          .filter((item) => (item.estimatedMonthlySavings ?? 0) > 0)
          .sort((left, right) => (right.estimatedMonthlySavings ?? 0) - (left.estimatedMonthlySavings ?? 0))
          .slice(0, 5)
          .map((item) => ({ id: item.id, title: item.title, type: item.type, currency: item.currency, estimatedMonthlySavings: item.estimatedMonthlySavings ?? 0, severity: item.severity, status: item.status })),
      },
      realization,
      budgets: summarizeBudgets(budgetRows),
      coverage: {
        status: readiness.status,
        inventoryResources: readiness.inventoryResources,
        linkedResourcesWithCost: readiness.linkedResourcesWithCost,
        linkedResourcesWithMetrics: readiness.linkedResourcesWithMetrics,
        linkedResourcesWithBoth: readiness.linkedResourcesWithBoth,
        costPercent: readiness.costs.coveragePercent,
        metricsPercent: readiness.metrics.coveragePercent,
        technicalRecommendationBlockers: readiness.technicalRecommendationBlockers,
      },
      ingestion: {
        totalConnections: readiness.connections.length,
        blockedConnections: readiness.connections.filter((item) => item.status === 'BLOCKED').length,
        partialConnections: readiness.connections.filter((item) => item.status === 'PARTIAL').length,
        ...(readiness.latestReconciliation?.status !== undefined ? { latestReconciliationStatus: readiness.latestReconciliation.status } : {}),
      },
    };
  }
}

function summarizeBudgets(rows: readonly { readonly budget: Awaited<ReturnType<IBudgetRepository['list']>>[number]; readonly actual: Awaited<ReturnType<IBudgetRepository['getActualCost']>>; readonly forecast: number | undefined }[]): readonly ExecutiveSummary['budgets'][number][] {
  const result = new Map<string, ExecutiveSummary['budgets'][number]>();
  for (const row of rows) {
    const current = result.get(row.budget.currency) ?? { currency: row.budget.currency, active: 0, atRisk: 0, exceeded: 0, plannedAmount: 0, forecastAmount: 0 };
    const compared = Math.max(row.actual.amount, row.forecast ?? 0);
    const ratio = compared / row.budget.amount;
    result.set(row.budget.currency, {
      ...current,
      active: current.active + 1,
      atRisk: current.atRisk + (ratio >= row.budget.warningThreshold && ratio < row.budget.exceededThreshold ? 1 : 0),
      exceeded: current.exceeded + (ratio >= row.budget.exceededThreshold ? 1 : 0),
      plannedAmount: round(current.plannedAmount + row.budget.amount),
      forecastAmount: round(current.forecastAmount + (row.forecast ?? row.actual.amount)),
    });
  }
  return [...result.values()];
}

function aggregateLatestPeriods(series: readonly { readonly month: string; readonly cost: number }[]): { readonly previous?: number; readonly percent?: number } {
  const totals = new Map<string, number>();
  for (const point of series) totals.set(point.month, (totals.get(point.month) ?? 0) + point.cost);
  const months = [...totals.keys()].sort();
  const latest = months.at(-1);
  const previous = months.at(-2);
  if (latest === undefined || previous === undefined) return {};
  const previousValue = totals.get(previous) ?? 0;
  const latestValue = totals.get(latest) ?? 0;
  return {
    previous: round(previousValue),
    ...(previousValue === 0 ? {} : { percent: round(((latestValue - previousValue) / previousValue) * 100, 2) }),
  };
}

function startOfMonth(date: Date): Date { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); }
function round(value: number, decimals = 2): number { const factor = 10 ** decimals; return Math.round(value * factor) / factor; }

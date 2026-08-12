import type { CostForecastScenario } from './costAnalytics/costForecastScenarioModels.js';
import type { ResourceLinkageReadiness } from './IResourceLinkageReadinessRepository.js';
import type { ValueRealizationSummary } from './IValueRealizationRepository.js';

export interface ExecutiveSummaryOpportunity {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly currency: string;
  readonly estimatedMonthlySavings: number;
  readonly severity: string;
  readonly status: string;
}

export interface ExecutiveSummaryBudgetCurrency {
  readonly currency: string;
  readonly active: number;
  readonly atRisk: number;
  readonly exceeded: number;
  readonly plannedAmount: number;
  readonly forecastAmount: number;
}

export interface ExecutiveSummary {
  readonly tenantId: string;
  readonly generatedAt: Date;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totalCost: number;
  readonly currency: string;
  readonly previousPeriodCost?: number;
  readonly variationPercent?: number;
  readonly forecastScenarios: readonly CostForecastScenario[];
  readonly opportunities: {
    readonly count: number;
    readonly potentialByCurrency: Readonly<Record<string, number>>;
    readonly top: readonly ExecutiveSummaryOpportunity[];
  };
  readonly realization: ValueRealizationSummary;
  readonly budgets: readonly ExecutiveSummaryBudgetCurrency[];
  readonly coverage: Pick<
    ResourceLinkageReadiness,
    'status' | 'inventoryResources' | 'linkedResourcesWithCost' | 'linkedResourcesWithMetrics' | 'linkedResourcesWithBoth' | 'technicalRecommendationBlockers'
  > & {
    readonly costPercent: number;
    readonly metricsPercent: number;
  };
  readonly ingestion: {
    readonly totalConnections: number;
    readonly blockedConnections: number;
    readonly partialConnections: number;
    readonly latestReconciliationStatus?: string;
  };
}

export interface IExecutiveSummaryService {
  getSummary(tenantId: string, now?: Date): Promise<ExecutiveSummary>;
}

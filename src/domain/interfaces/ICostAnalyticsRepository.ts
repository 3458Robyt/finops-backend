export interface CostAnalyticsProviderItem {
  readonly provider: string;
  readonly totalCost: number;
  readonly metricCount: number;
}

export interface CostAnalyticsAccountItem {
  readonly cloudAccountId: string;
  readonly provider: string;
  readonly name: string;
  readonly totalCost: number;
  readonly metricCount: number;
}

export interface CostAnalyticsServiceItem {
  readonly serviceName: string;
  readonly provider: string;
  readonly totalCost: number;
  readonly metricCount: number;
}

export interface CostAnalyticsEnvironmentItem {
  readonly environment: string;
  readonly totalCost: number;
  readonly metricCount: number;
}

export interface CostAnalyticsResourceItem {
  readonly resourceId: string;
  readonly serviceName: string;
  readonly provider: string;
  readonly totalCost: number;
  readonly metricCount: number;
}

export interface CostAnalyticsUsageItem {
  readonly serviceName: string;
  readonly provider: string;
  readonly consumedQuantity: number;
  readonly consumedUnit: string;
  readonly totalCost: number;
  readonly unitCost?: number;
  readonly currency: string;
  readonly metricCount: number;
}

export interface CostAnalyticsSnapshot {
  readonly tenantId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totalCost: number;
  readonly currency: string;
  readonly metricCount: number;
  readonly providers: readonly CostAnalyticsProviderItem[];
  readonly accounts: readonly CostAnalyticsAccountItem[];
  readonly services: readonly CostAnalyticsServiceItem[];
  readonly environments: readonly CostAnalyticsEnvironmentItem[];
  readonly topResources: readonly CostAnalyticsResourceItem[];
  readonly topUsage?: readonly CostAnalyticsUsageItem[];
  readonly usageInsights?: readonly UsageInsight[];
  readonly anomalies?: readonly CostAnomaly[];
  readonly forecasts?: readonly CostForecast[];
}

export type AnalyticsGroupBy = 'provider' | 'account' | 'service' | 'resource' | 'environment';
export type CostAnomalySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type CostAnomalyStatus = 'OPEN' | 'LINKED_TO_RECOMMENDATION' | 'RESOLVED';

export interface AnalyticsFilters {
  readonly from?: Date;
  readonly to?: Date;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly groupBy?: AnalyticsGroupBy;
}

export interface MonthlyCostPoint {
  readonly month: string;
  readonly groupBy: AnalyticsGroupBy;
  readonly groupKey: string;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  readonly cost: number;
  readonly currency: string;
  readonly metricCount: number;
}

export interface MonthlyUsagePoint {
  readonly month: string;
  readonly groupBy: AnalyticsGroupBy;
  readonly groupKey: string;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  readonly consumedQuantity: number;
  readonly consumedUnit: string;
  readonly cost: number;
  readonly unitCost?: number;
  readonly currency: string;
  readonly metricCount: number;
}

export type UsageInsightKind =
  | 'CONSUMPTION_GROWTH'
  | 'UNIT_COST_INCREASE'
  | 'COST_USAGE_DIVERGENCE'
  | 'HIGH_USAGE_LOW_COST'
  | 'INSUFFICIENT_USAGE_DATA';

export type UsageInsightSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface UsageInsight {
  readonly id: string;
  readonly kind: UsageInsightKind;
  readonly severity: UsageInsightSeverity;
  readonly groupBy: AnalyticsGroupBy;
  readonly groupKey: string;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  readonly title: string;
  readonly description: string;
  readonly consumedQuantity?: number;
  readonly consumedUnit?: string;
  readonly cost?: number;
  readonly unitCost?: number;
  readonly deltaConsumptionPercent?: number;
  readonly deltaCostPercent?: number;
  readonly evidenceLevel: 'COST_ONLY' | 'COST_AND_USAGE' | 'COST_USAGE_AND_TECHNICAL';
  readonly currency: string;
  readonly evidence: unknown;
}

export interface CostAnomaly {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly provider?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly baselineCost: number;
  readonly observedCost: number;
  readonly deltaAmount: number;
  readonly deltaPercent: number;
  readonly zScore?: number;
  readonly severity: CostAnomalySeverity;
  readonly status: CostAnomalyStatus;
  readonly explanation: string;
  readonly evidence?: unknown;
  readonly detectedAt: string;
}

export interface CostForecast {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly provider?: string;
  readonly serviceName?: string;
  readonly groupBy: AnalyticsGroupBy | 'total';
  readonly groupKey: string;
  readonly forecastMonth: string;
  readonly predictedCost: number;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly method: string;
  readonly confidence: number;
  readonly currency: string;
  readonly evidence?: unknown;
  readonly generatedAt: string;
}

export interface CostTrend {
  readonly groupBy: AnalyticsGroupBy | 'total';
  readonly groupKey: string;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly points: readonly MonthlyCostPoint[];
  readonly totalCost: number;
  readonly deltaAmount: number;
  readonly deltaPercent: number;
  readonly currency: string;
}

export interface PersistCostAnomalyInput {
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly provider?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly baselineCost: number;
  readonly observedCost: number;
  readonly deltaAmount: number;
  readonly deltaPercent: number;
  readonly zScore?: number;
  readonly severity: CostAnomalySeverity;
  readonly status: CostAnomalyStatus;
  readonly explanation: string;
  readonly evidence?: unknown;
}

export interface PersistCostForecastInput {
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly provider?: string;
  readonly serviceName?: string;
  readonly groupBy: AnalyticsGroupBy | 'total';
  readonly groupKey: string;
  readonly forecastMonth: Date;
  readonly predictedCost: number;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly method: string;
  readonly confidence: number;
  readonly currency: string;
  readonly evidence?: unknown;
}

export interface ICostAnalyticsRepository {
  getLatestTenantSnapshot(tenantId: string): Promise<CostAnalyticsSnapshot>;
  getMonthlyCostSeries(tenantId: string, filters?: AnalyticsFilters): Promise<MonthlyCostPoint[]>;
  getMonthlyUsageSeries(tenantId: string, filters?: AnalyticsFilters): Promise<MonthlyUsagePoint[]>;
  findAnomalies(tenantId: string, filters?: AnalyticsFilters): Promise<CostAnomaly[]>;
  replaceAnomalies(tenantId: string, anomalies: readonly PersistCostAnomalyInput[]): Promise<CostAnomaly[]>;
  findForecasts(tenantId: string, filters?: AnalyticsFilters): Promise<CostForecast[]>;
  replaceForecasts(tenantId: string, forecasts: readonly PersistCostForecastInput[]): Promise<CostForecast[]>;
}

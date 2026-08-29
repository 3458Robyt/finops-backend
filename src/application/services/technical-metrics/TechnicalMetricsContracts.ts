import type {
  CloudResourceItem,
  TechnicalCostContextItem,
  TechnicalMetricSeriesBucket,
  TechnicalMetricSummaryItem,
} from '../../../domain/interfaces/IResourceMetricRepository.js';
import type { MetricStatistic } from '../../../domain/interfaces/ICloudIngestionProvider.js';
import type { TechnicalEvidenceStrength } from '../ai/TechnicalOptimizationRuleEngine.js';
import type { RecommendationReadiness } from '../ai/RecommendationReadinessGate.js';


export type TechnicalMetricGroup = 'CPU' | 'MEMORY' | 'NETWORK' | 'DISK' | 'SYSTEM' | 'OTHER';
export type TechnicalCostMatchLevel = 'EXACT' | 'SERVICE' | 'NONE';
export type TechnicalMetricBucket = 'auto' | 'raw' | '30m' | 'hour' | 'day';

export interface TechnicalMetricOverviewInput {
  readonly startDate?: Date;
  readonly endDate?: Date;
  readonly externalResourceId?: string;
  readonly cloudResourceId?: string;
  readonly metricNames?: readonly string[];
  readonly statistic?: MetricStatistic;
}

export interface TechnicalMetricSeriesInput extends TechnicalMetricOverviewInput {
  readonly bucket?: TechnicalMetricBucket;
  readonly cursor?: string;
  readonly pageSize?: number;
}

export type TechnicalMetricCoverageDayStatus = 'WITH_DATA' | 'NO_DATA';

export interface TechnicalMetricCoverageMetric {
  readonly metricName: string;
  readonly sampleCount: number;
  readonly daysWithData: number;
  readonly expectedDays: number;
  readonly coveragePercent: number;
  readonly minSampledAt?: Date;
  readonly maxSampledAt?: Date;
}

export interface TechnicalMetricCoverageDay {
  readonly date: string;
  readonly sampleCount: number;
  readonly metricCount: number;
  readonly status: TechnicalMetricCoverageDayStatus;
}

export interface TechnicalMetricCoverage {
  readonly rangeStart?: Date;
  readonly rangeEnd?: Date;
  readonly minSampledAt?: Date;
  readonly maxSampledAt?: Date;
  readonly totalSamples: number;
  readonly metricCount: number;
  readonly resourceCount: number;
  readonly expectedDays: number;
  readonly daysWithData: number;
  readonly coveragePercent: number;
  readonly metrics: readonly TechnicalMetricCoverageMetric[];
  readonly days: readonly TechnicalMetricCoverageDay[];
}

export interface TechnicalMetricCatalogItem {
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly group: TechnicalMetricGroup;
  readonly sampleCount: number;
  readonly minSampledAt: Date;
  readonly maxSampledAt: Date;
  readonly availableStatistics?: readonly MetricStatistic[];
}

export interface TechnicalMetricKpi {
  readonly id: string;
  readonly label: string;
  readonly group: TechnicalMetricGroup;
  readonly metricNames: readonly string[];
  readonly unit?: string;
  readonly average: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly latest: number;
  readonly latestSampledAt: Date;
  readonly sampleCount: number;
}

export interface TechnicalMetricResourceSummary {
  readonly cloudResourceId?: string;
  readonly cloudConnectionId?: string;
  readonly externalResourceId: string;
  readonly provider: string;
  readonly name?: string;
  readonly serviceName?: string;
  readonly resourceType?: string;
  readonly regionId?: string;
  readonly status?: string;
  readonly metricNames: readonly string[];
  readonly sampleCount: number;
  readonly minSampledAt: Date;
  readonly maxSampledAt: Date;
  readonly cost?: {
    readonly totalCost: number;
    readonly currency: string;
    readonly metricCount: number;
    readonly matchLevel: TechnicalCostMatchLevel;
  };
}

export interface TechnicalMetricOpportunity {
  readonly id: string;
  readonly severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';
  readonly title: string;
  readonly description: string;
  readonly externalResourceId?: string;
  readonly cloudResourceId?: string;
  readonly metricName?: string;
  readonly value?: number;
  readonly unit?: string;
  readonly cost?: number;
  readonly currency?: string;
}

export interface TechnicalMetricsOverview {
  readonly minSampledAt?: Date;
  readonly maxSampledAt?: Date;
  readonly latestSampledAt?: Date;
  readonly resourceCount: number;
  readonly metricCount: number;
  readonly sampleCount: number;
  readonly resources: readonly TechnicalMetricResourceSummary[];
  readonly metrics: readonly TechnicalMetricCatalogItem[];
  readonly kpis: readonly TechnicalMetricKpi[];
  readonly opportunities: readonly TechnicalMetricOpportunity[];
}

export interface TechnicalMetricSeriesPoint {
  readonly bucketStart: Date;
  readonly externalResourceId: string;
  readonly cloudResourceId?: string;
  readonly providerNamespace?: string;
  readonly regionId?: string;
  readonly dimensionsHash?: string;
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly statistic: MetricStatistic;
  readonly value: number;
  readonly aggregationSemantics: string;
  readonly sourceGranularitiesSeconds: readonly number[];
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly latest: number;
  readonly sampleCount: number;
  readonly minSampledAt?: Date;
  readonly maxSampledAt?: Date;
  readonly latestSampledAt?: Date;
}

export interface TechnicalMetricSeriesMeta {
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly returnedPoints: number;
  readonly totalSamples: number;
  readonly queryMs: number;
  readonly bucket: TechnicalMetricSeriesBucket;
  readonly pageSize: number;
  readonly statistic: MetricStatistic;
}

export interface TechnicalMetricSeriesResult {
  readonly series: readonly TechnicalMetricSeriesPoint[];
  readonly meta: TechnicalMetricSeriesMeta;
}

export interface TechnicalResourceSummary {
  readonly resource: CloudResourceItem;
  readonly metrics: readonly TechnicalMetricSummaryItem[];
  readonly coverage: TechnicalMetricCoverage;
  readonly evidence: {
    readonly strength: TechnicalEvidenceStrength;
    readonly readiness: RecommendationReadiness;
    readonly blockers: readonly string[];
    readonly ruleMatches: readonly string[];
  };
  readonly cost?: TechnicalCostContextItem;
}

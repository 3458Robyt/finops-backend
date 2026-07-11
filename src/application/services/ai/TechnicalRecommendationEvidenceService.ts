import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type {
  IResourceMetricRepository,
  TechnicalCostContextItem,
  TechnicalMetricSummaryItem,
} from '../../../domain/interfaces/IResourceMetricRepository.js';
import { evaluateTechnicalOptimizationRules } from './TechnicalOptimizationRuleEngine.js';
import {
  formatRecommendationEvidenceSnapshot,
  hashRecommendationEvidenceSnapshot,
  recommendationEvidenceSnapshotVersion,
  type RecommendationEvidenceMetric,
  type RecommendationEvidenceResource,
  type RecommendationEvidenceSnapshot,
} from './RecommendationEvidenceSnapshot.js';

export interface TechnicalRecommendationEvidenceProvider {
  buildRecommendationEvidenceSnapshot(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
    readonly externalResourceId?: string;
  }): Promise<RecommendationEvidenceSnapshot>;
}

const maxResources = 12;
const maxMetricsPerResource = 8;

export class TechnicalRecommendationEvidenceService implements TechnicalRecommendationEvidenceProvider {
  public constructor(private readonly repository: IResourceMetricRepository) {}

  public async buildRecommendationEvidenceSnapshot(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
    readonly externalResourceId?: string;
  }): Promise<RecommendationEvidenceSnapshot> {
    const startDate = parseDate(input.snapshot.periodStart);
    const endDate = parseDate(input.snapshot.periodEnd);
    const summaries = await this.repository.listMetricSummariesForTenant(input.tenantId, {
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      ...(input.externalResourceId !== undefined ? { externalResourceIds: [input.externalResourceId] } : {}),
      limit: 1000,
    });
    const deterministicRules = evaluateTechnicalOptimizationRules({
      summaries,
      referenceDate: endDate ?? new Date(),
    });
    const resourceIds = [...new Set(summaries.map((summary) => summary.externalResourceId))];
    const costContext = await this.repository.listCostContextForResources(input.tenantId, resourceIds);
    const resources = buildResources(input.snapshot, summaries, costContext, deterministicRules);
    const availability = resources.length === 0
      ? 'NO_TECHNICAL_EVIDENCE'
      : 'COST_USAGE_AND_TECHNICAL_AVAILABLE';
    const base = {
      version: recommendationEvidenceSnapshotVersion,
      tenantId: input.tenantId,
      periodStart: input.snapshot.periodStart,
      periodEnd: input.snapshot.periodEnd,
      generatedAt: new Date().toISOString(),
      availability,
      resources,
      deterministicRules,
    } as const;

    return { ...base, hash: hashRecommendationEvidenceSnapshot(base) };
  }

  /** Compatibilidad temporal para consumidores de prompts existentes. */
  public async buildRecommendationEvidence(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
    readonly externalResourceId?: string;
  }): Promise<string> {
    return formatRecommendationEvidenceSnapshot(await this.buildRecommendationEvidenceSnapshot(input));
  }
}

function buildResources(
  snapshot: CostAnalyticsSnapshot,
  summaries: readonly TechnicalMetricSummaryItem[],
  costContext: readonly TechnicalCostContextItem[],
  deterministicRules: readonly ReturnType<typeof evaluateTechnicalOptimizationRules>[number][],
): readonly RecommendationEvidenceResource[] {
  const byResource = groupBy(summaries, (summary) => summary.externalResourceId);
  const costByResource = new Map(costContext.map((item) => [item.externalResourceId, item]));
  const ruleByResource = new Map(deterministicRules.map((rule) => [rule.externalResourceId, rule]));

  return [...byResource.entries()]
    .map(([externalResourceId, resourceSummaries]) => {
      const first = resourceSummaries[0]!;
      const cost = costByResource.get(externalResourceId);
      const ruleEvaluation = ruleByResource.get(externalResourceId);
      if (ruleEvaluation === undefined) {
        return undefined;
      }
      return {
        externalResourceId,
        ...(first.cloudResourceId !== undefined ? { cloudResourceId: first.cloudResourceId } : {}),
        provider: first.provider,
        ...(first.resourceType !== undefined ? { resourceType: first.resourceType } : {}),
        ...(first.serviceName !== undefined ? { serviceName: first.serviceName } : {}),
        linkQuality: cost === undefined ? 'TECHNICAL_ONLY' : 'COST_AND_TECHNICAL',
        ...(cost !== undefined ? { cost: toCost(cost) } : {}),
        usage: (snapshot.topUsage ?? [])
          .filter((usage) => usage.provider === first.provider && usage.serviceName === first.serviceName)
          .map((usage) => ({
            serviceName: usage.serviceName,
            consumedQuantity: round(usage.consumedQuantity),
            consumedUnit: usage.consumedUnit,
            totalCost: round(usage.totalCost),
            currency: usage.currency,
          })),
        metrics: resourceSummaries
          .map(toMetric)
          .sort((left, right) => right.sampleCount - left.sampleCount)
          .slice(0, maxMetricsPerResource),
        ruleEvaluation,
      } as RecommendationEvidenceResource;
    })
    .filter((resource): resource is RecommendationEvidenceResource => resource !== undefined)
    .sort((left, right) => (right.cost?.totalCost ?? 0) - (left.cost?.totalCost ?? 0))
    .slice(0, maxResources);
}

function toCost(cost: TechnicalCostContextItem): NonNullable<RecommendationEvidenceResource['cost']> {
  return {
    totalCost: round(cost.totalCost),
    currency: cost.currency,
    focusMetricCount: cost.metricCount,
  };
}

function toMetric(summary: TechnicalMetricSummaryItem): RecommendationEvidenceMetric {
  return {
    metricName: summary.metricName,
    ...(summary.metricUnit !== undefined ? { metricUnit: summary.metricUnit } : {}),
    sampleCount: summary.sampleCount,
    coverageDays: summary.coverageDays,
    min: round(summary.min),
    max: round(summary.max),
    avg: round(summary.avg),
    p50: round(summary.p50),
    p95: round(summary.p95),
    p99: round(summary.p99),
    latest: round(summary.latest),
    firstSampledAt: summary.firstSampledAt.toISOString(),
    latestSampledAt: summary.latestSampledAt.toISOString(),
    evidenceRef: `resource_metric_samples:${summary.externalResourceId}:${summary.metricName}:${summary.latestSampledAt.toISOString()}`,
  };
}

function parseDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>;
  for (const item of items) {
    grouped.set(keyFn(item), [...(grouped.get(keyFn(item)) ?? []), item]);
  }
  return grouped;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

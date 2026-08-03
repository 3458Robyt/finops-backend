import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type {
  IResourceMetricRepository,
  TechnicalCostContextItem,
  TechnicalMetricSummaryItem,
} from '../../../domain/interfaces/IResourceMetricRepository.js';
import { evaluateTechnicalOptimizationRules, technicalMetricEvidenceRef } from './TechnicalOptimizationRuleEngine.js';
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
    readonly cloudResourceId?: string;
  }): Promise<RecommendationEvidenceSnapshot>;
}

const maxResources = 12;
const maxMetricsPerResource = 8;
const technicalEvidenceLookbackDays = 30;

export class TechnicalRecommendationEvidenceService implements TechnicalRecommendationEvidenceProvider {
  public constructor(private readonly repository: IResourceMetricRepository) {}

  public async buildRecommendationEvidenceSnapshot(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
    readonly externalResourceId?: string;
    readonly cloudResourceId?: string;
  }): Promise<RecommendationEvidenceSnapshot> {
    const startDate = parseDate(input.snapshot.periodStart);
    const endDate = parseDate(input.snapshot.periodEnd);
    const now = new Date();
    const evidenceStartDate = startDate === undefined
      ? undefined
      : new Date(startDate.getTime() - technicalEvidenceLookbackDays * 24 * 60 * 60 * 1000);
    const evidenceEndDate = endDate !== undefined && endDate <= now ? endDate : now;
    const referenceDate = evidenceEndDate;
    const summaries = await this.repository.listMetricSummariesForTenant(input.tenantId, {
      ...(evidenceStartDate !== undefined ? { startDate: evidenceStartDate } : {}),
      ...(evidenceEndDate !== undefined ? { endDate: evidenceEndDate } : {}),
      ...(input.externalResourceId !== undefined ? { externalResourceIds: [input.externalResourceId] } : {}),
      ...(input.cloudResourceId !== undefined ? { cloudResourceIds: [input.cloudResourceId] } : {}),
      limit: 1000,
    });
    const deterministicRules = evaluateTechnicalOptimizationRules({
      summaries,
      referenceDate,
    });
    const resourceIds = [...new Set(summaries.map((summary) => summary.externalResourceId))];
    const cloudResourceIds = [...new Set(summaries.map((summary) => summary.cloudResourceId).filter((value): value is string => value !== undefined))];
    const costContext = await this.repository.listCostContextForResources(input.tenantId, resourceIds, cloudResourceIds);
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
  const byResource = groupBy(summaries, resourceKey);
  const costByResource = new Map(costContext.map((item) => [costKey(item), item]));
  const ruleByResource = new Map(deterministicRules.map((rule) => [resourceKey(rule), rule]));

  return [...byResource.entries()]
    .map(([, resourceSummaries]) => {
      const first = resourceSummaries[0]!;
      const externalResourceId = first.externalResourceId;
      const cost = costByResource.get(resourceKey(first));
      const ruleEvaluation = ruleByResource.get(resourceKey(first));
      if (ruleEvaluation === undefined) {
        return undefined;
      }
      return {
        externalResourceId,
        ...(first.cloudResourceId !== undefined ? { cloudResourceId: first.cloudResourceId } : {}),
        ...(first.cloudConnectionId !== undefined ? { cloudConnectionId: first.cloudConnectionId } : {}),
        provider: first.provider,
        ...(first.resourceType !== undefined ? { resourceType: first.resourceType } : {}),
        ...(first.serviceName !== undefined ? { serviceName: first.serviceName } : {}),
        linkQuality: cost !== undefined
          && first.cloudResourceId !== undefined
          && cost.cloudResourceId === first.cloudResourceId
          ? 'COST_AND_TECHNICAL'
          : 'TECHNICAL_ONLY',
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
    ...(cost.cloudResourceId !== undefined ? { cloudResourceId: cost.cloudResourceId } : {}),
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
    highUtilizationSampleCount: summary.highUtilizationSampleCount ?? 0,
    highUtilizationRatio: round(summary.highUtilizationRatio ?? 0),
    firstSampledAt: summary.firstSampledAt.toISOString(),
    latestSampledAt: summary.latestSampledAt.toISOString(),
    evidenceRef: technicalMetricEvidenceRef(summary),
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

function resourceKey(input: {
  readonly cloudResourceId?: string;
  readonly cloudConnectionId?: string;
  readonly provider: string;
  readonly externalResourceId: string;
}): string {
  return input.cloudResourceId
    ?? `${input.cloudConnectionId ?? 'unknown'}\u0000${input.provider}\u0000${input.externalResourceId}`;
}

function costKey(input: TechnicalCostContextItem): string {
  return input.cloudResourceId
    ?? `${input.cloudConnectionId ?? 'unknown'}\u0000${input.externalResourceId}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

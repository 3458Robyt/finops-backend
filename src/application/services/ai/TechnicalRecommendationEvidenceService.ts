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
  /** Bounded overview evidence for interactive chat; recommendations stay exact. */
  buildChatTechnicalEvidenceSnapshot?(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
  }): Promise<RecommendationEvidenceSnapshot>;
}

const maxResources = 12;
const maxMetricsPerResource = 8;
const technicalEvidenceLookbackDays = 7;
const maxEvidenceSummaries = 1000;

export class TechnicalRecommendationEvidenceService implements TechnicalRecommendationEvidenceProvider {
  public constructor(private readonly repository: IResourceMetricRepository) {}

  public async buildRecommendationEvidenceSnapshot(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
    readonly externalResourceId?: string;
    readonly cloudResourceId?: string;
  }): Promise<RecommendationEvidenceSnapshot> {
    return this.buildEvidenceSnapshot(input, false);
  }

  public async buildChatTechnicalEvidenceSnapshot(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
  }): Promise<RecommendationEvidenceSnapshot> {
    return this.buildEvidenceSnapshot(input, true);
  }

  private async buildEvidenceSnapshot(input: {
    readonly tenantId: string;
    readonly snapshot: CostAnalyticsSnapshot;
    readonly externalResourceId?: string;
    readonly cloudResourceId?: string;
  }, preferBoundedRollups: boolean): Promise<RecommendationEvidenceSnapshot> {
    const now = new Date();
    // Current optimization decisions require current measurements, even when
    // the latest billing snapshot closes several days earlier.
    const evidenceStartDate = new Date(now.getTime() - technicalEvidenceLookbackDays * 24 * 60 * 60 * 1000);
    const evidenceEndDate = now;
    const referenceDate = now;
    const candidateResourceIds: string[] = input.externalResourceId === undefined
      ? [...new Set(input.snapshot.topResources.map((resource) => resource.resourceId).filter((id) => id.trim() !== ''))]
      : [input.externalResourceId];
    const summaryReader = preferBoundedRollups && this.repository.listMetricSummariesForTenantFast !== undefined
      ? this.repository.listMetricSummariesForTenantFast.bind(this.repository)
      : this.repository.listMetricSummariesForTenant.bind(this.repository);
    const fetchedSummaries = await summaryReader(input.tenantId, {
      ...(evidenceStartDate !== undefined ? { startDate: evidenceStartDate } : {}),
      ...(evidenceEndDate !== undefined ? { endDate: evidenceEndDate } : {}),
      ...(candidateResourceIds.length > 0 ? { externalResourceIds: candidateResourceIds } : {}),
      ...(input.cloudResourceId !== undefined ? { cloudResourceIds: [input.cloudResourceId] } : {}),
      limit: maxEvidenceSummaries + 1,
    });
    const summaryTruncated = fetchedSummaries.length > maxEvidenceSummaries;
    const summaries = fetchedSummaries.slice(0, maxEvidenceSummaries);
    const deterministicRules = evaluateTechnicalOptimizationRules({
      summaries,
      referenceDate,
    });
    const resourceIds = [...new Set(summaries.map((summary) => summary.externalResourceId))];
    const cloudResourceIds = [...new Set(summaries.map((summary) => summary.cloudResourceId).filter((value): value is string => value !== undefined))];
    const costStart = new Date(input.snapshot.periodStart);
    const costEnd = new Date(input.snapshot.periodEnd);
    const costContext = await this.repository.listCostContextForResources(input.tenantId, resourceIds, cloudResourceIds,
      Number.isFinite(costStart.getTime()) && Number.isFinite(costEnd.getTime())
        ? { start: costStart, end: costEnd }
        : undefined);
    const sourceDiagnostics = await this.repository.listMetricSourceDiagnosticsForTenant?.(
      input.tenantId,
      input.snapshot.topResources.map((resource) => ({
        externalResourceId: resource.resourceId,
        ...(resource.cloudConnectionId === undefined ? {} : { cloudConnectionId: resource.cloudConnectionId }),
      })),
    );
    const resources = buildResources(summaries, costContext, deterministicRules);
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
      ...(summaryTruncated ? { summaryTruncated: true } : {}),
      resources,
      deterministicRules,
      ...(sourceDiagnostics === undefined ? {} : { sourceDiagnostics: sourceDiagnostics.map((item) => ({
        externalResourceId: item.externalResourceId,
        cloudConnectionId: item.cloudConnectionId,
        metricName: item.metricName,
        catalogStatus: item.catalogStatus,
        ...(item.lastDiscoveredAt === undefined ? {} : { lastDiscoveredAt: item.lastDiscoveredAt.toISOString() }),
        ...(item.latestJobStatus === undefined ? {} : { latestJobStatus: item.latestJobStatus }),
      })) }),
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
        ...(first.resourceName !== undefined && first.resourceName.trim() !== ''
          ? { resourceName: first.resourceName }
          : {}),
        provider: first.provider,
        ...(first.resourceType !== undefined ? { resourceType: first.resourceType } : {}),
        ...(first.serviceName !== undefined ? { serviceName: first.serviceName } : {}),
        linkQuality: cost !== undefined
          && first.cloudResourceId !== undefined
          && cost.cloudResourceId === first.cloudResourceId
          ? 'COST_AND_TECHNICAL'
          : 'TECHNICAL_ONLY',
        ...(cost !== undefined ? { cost: toCost(cost) } : {}),
        // topUsage is aggregated by service, not measured for this resource.
        usage: [],
        metrics: resourceSummaries
          .map(toMetric)
          .sort((left, right) => metricPriority(left.metricName) - metricPriority(right.metricName)
            || right.sampleCount - left.sampleCount)
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
    ...(summary.providerNamespace !== undefined ? { providerNamespace: summary.providerNamespace } : {}),
    ...(summary.regionId !== undefined ? { regionId: summary.regionId } : {}),
    ...(summary.compartmentId !== undefined ? { compartmentId: summary.compartmentId } : {}),
    ...(summary.dimensionsHash !== undefined ? { dimensionsHash: summary.dimensionsHash } : {}),
    statistic: summary.statistic,
    ...(summary.granularitySeconds !== undefined ? { granularitySeconds: summary.granularitySeconds } : {}),
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

function metricPriority(name: string): number {
  if (name.toLowerCase().replace(/[^a-z]/g, '') === 'cpuutilization') return 0;
  if (name.toLowerCase().replace(/[^a-z]/g, '') === 'memoryutilization') return 1;
  return 2;
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

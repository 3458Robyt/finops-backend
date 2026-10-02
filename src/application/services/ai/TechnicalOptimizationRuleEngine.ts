import type { TechnicalMetricSummaryItem } from '../../../domain/interfaces/IResourceMetricRepository.js';
import type { RecommendationReadiness } from './RecommendationReadinessGate.js';
import {
  defaultTechnicalOptimizationRuleConfig,
  type TechnicalOptimizationRuleConfig,
} from './TechnicalOptimizationRuleConfig.js';

export type TechnicalEvidenceStrength = 'LOW' | 'MEDIUM' | 'HIGH';

export type TechnicalRecommendedActionType =
  | 'RIGHTSIZING'
  | 'IDLE_STOP_REVIEW'
  | 'PERFORMANCE_CAPACITY_REVIEW'
  | 'TECHNICAL_VALIDATION_REQUIRED';

export function technicalMetricEvidenceRef(summary: Pick<TechnicalMetricSummaryItem, 'cloudResourceId' | 'cloudConnectionId' | 'externalResourceId' | 'metricName' | 'providerNamespace' | 'regionId' | 'compartmentId' | 'dimensionsHash' | 'statistic' | 'granularitySeconds' | 'latestSampledAt'>): string {
  return `resource_metric_samples:${summary.cloudResourceId ?? summary.cloudConnectionId ?? 'unresolved'}:${summary.externalResourceId}:${summary.metricName}:${summary.latestSampledAt.toISOString()}:${summary.providerNamespace ?? 'unknown'}:${summary.regionId ?? 'unknown'}:${summary.compartmentId ?? 'unknown'}:${summary.statistic}:${summary.dimensionsHash ?? 'unknown'}:${summary.granularitySeconds ?? 'unknown'}`;
}

export interface TechnicalResourceRuleEvaluation {
  readonly externalResourceId: string;
  readonly cloudResourceId?: string;
  readonly cloudConnectionId?: string;
  readonly provider: string;
  readonly resourceType?: string;
  readonly serviceName?: string;
  readonly readiness: RecommendationReadiness;
  readonly evidenceStrength: TechnicalEvidenceStrength;
  readonly recommendedActionType: TechnicalRecommendedActionType;
  readonly ruleMatches: readonly string[];
  readonly blockers: readonly string[];
  readonly sourceFacts: readonly string[];
  readonly technicalEvidenceRefs: readonly string[];
  readonly metricSummary: readonly TechnicalMetricRuleSummary[];
  /** Always zero until a deterministic estimator prices a concrete target configuration. */
  readonly maxTechnicalSavingsRate: number;
  readonly ruleVersion?: string;
  readonly appliedThresholds?: Readonly<{
    readonly highUtilizationPercent: number;
    readonly cpuCriticalP99Percent: number;
    readonly sustainedHighUtilizationRatio: number;
    readonly minimumSamples: number;
    readonly minimumCoverageDays: number;
    readonly recentSampleMaxAgeDays: number;
  }>;
}

export interface TechnicalMetricRuleSummary {
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly providerNamespace?: string;
  readonly regionId?: string;
  readonly compartmentId?: string;
  readonly dimensionsHash?: string;
  readonly statistic?: string;
  readonly sampleCount: number;
  readonly granularitySeconds?: number;
  readonly coverageDays: number;
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly latest: number;
  readonly highUtilizationSampleCount: number;
  readonly highUtilizationRatio: number;
  readonly firstSampledAt: string;
  readonly latestSampledAt: string;
}

export function evaluateTechnicalOptimizationRules(input: {
  readonly summaries: readonly TechnicalMetricSummaryItem[];
  readonly referenceDate: Date;
  readonly ruleConfig?: TechnicalOptimizationRuleConfig;
}): readonly TechnicalResourceRuleEvaluation[] {
  const ruleConfig = input.ruleConfig ?? defaultTechnicalOptimizationRuleConfig;
  const byResource = groupBy(input.summaries, resourceKey);

  return [...byResource.values()].map((summaries) =>
    evaluateResource(summaries[0]?.externalResourceId ?? 'UNKNOWN', summaries, input.referenceDate, ruleConfig),
  );
}

function resourceKey(summary: TechnicalMetricSummaryItem): string {
  return summary.cloudResourceId
    ?? `${summary.cloudConnectionId ?? 'unknown'}\u0000${summary.provider}\u0000${summary.externalResourceId}`;
}

function evaluateResource(
  externalResourceId: string,
  summaries: readonly TechnicalMetricSummaryItem[],
  referenceDate: Date,
  ruleConfig: TechnicalOptimizationRuleConfig,
): TechnicalResourceRuleEvaluation {
  const first = summaries[0];
  const cpuSelection = selectUtilizationMetric(summaries, 'cpu', referenceDate, ruleConfig);
  const memorySelection = selectUtilizationMetric(summaries, 'memory', referenceDate, ruleConfig);
  const cpu = cpuSelection.summary;
  const memory = memorySelection.summary;
  const network = findMetric(summaries, 'network');
  const disk = findMetric(summaries, 'disk');
  const iops = findMetric(summaries, 'iops');
  const blockers: string[] = [];
  const ruleMatches: string[] = [];
  const sourceFacts: string[] = [];

  const isCompute = first?.resourceType === 'COMPUTE_INSTANCE';
  if (!isCompute) {
    blockers.push('UNSUPPORTED_RESOURCE_TYPE');
  }
  if (isCompute) {
    if (cpuSelection.ambiguous) blockers.push('AMBIGUOUS_CPU_STREAM');
    if (memorySelection.ambiguous) blockers.push('AMBIGUOUS_MEMORY_STREAM');
    const coverageOk = cpu !== undefined && memory !== undefined
      && hasEnoughCoverage(cpu, referenceDate, ruleConfig)
      && hasEnoughCoverage(memory, referenceDate, ruleConfig);
    if (!coverageOk) {
      blockers.push('INSUFFICIENT_TECHNICAL_COVERAGE');
    }

    if (cpu === undefined) {
      blockers.push('MISSING_CPU_METRIC');
    } else if (!isPercentMetric(cpu)) {
      blockers.push('CPU_METRIC_UNIT_NOT_PERCENTAGE');
    } else {
      sourceFacts.push(metricFact('CPU', cpu));
      if (isHighUtilization(cpu, ruleConfig) || cpu.p99 >= ruleConfig.cpuCriticalP99Percent) {
        blockers.push('CPU_SATURATION_RISK');
        ruleMatches.push('CPU_HIGH_UTILIZATION');
      } else if (cpu.avg <= ruleConfig.cpuIdleAveragePercent && cpu.p95 <= ruleConfig.cpuIdleP95Percent) {
        ruleMatches.push('CPU_IDLE_CANDIDATE');
      } else if (cpu.avg <= ruleConfig.cpuStrongAveragePercent && cpu.p95 <= ruleConfig.cpuStrongP95Percent) {
        ruleMatches.push('CPU_STRONG_UNDERUTILIZATION');
      } else if (cpu.avg <= ruleConfig.cpuModerateAveragePercent && cpu.p95 <= ruleConfig.cpuModerateP95Percent) {
        ruleMatches.push('CPU_MODERATE_UNDERUTILIZATION');
      }
    }

    if (memory === undefined) {
      blockers.push('MISSING_MEMORY_METRIC');
    } else if (!isPercentMetric(memory)) {
      blockers.push('MEMORY_METRIC_UNIT_NOT_PERCENTAGE');
    } else {
      sourceFacts.push(metricFact('Memoria', memory));
      if (isHighUtilization(memory, ruleConfig)) {
        blockers.push('MEMORY_SATURATION_RISK');
        ruleMatches.push('MEMORY_HIGH_UTILIZATION');
      } else if (memory.avg <= ruleConfig.memoryLowAveragePercent && memory.p95 <= ruleConfig.memoryLowP95Percent) {
        ruleMatches.push('MEMORY_LOW_UTILIZATION');
      }
    }

    for (const [label, code, summary] of [
      ['Red', 'NETWORK', network],
      ['Disco', 'DISK', disk],
      ['IOPS', 'IOPS', iops],
    ] as const) {
      if (summary === undefined) {
        continue;
      }
      sourceFacts.push(metricFact(label, summary));
      if (isPercentMetric(summary)) {
        if (isHighUtilization(summary, ruleConfig)) {
          blockers.push(`${code}_SATURATION_RISK`);
          ruleMatches.push(`${code}_HIGH_UTILIZATION`);
        } else if (
          summary.avg <= ruleConfig.auxiliaryLowAveragePercent
          && summary.p95 <= ruleConfig.auxiliaryLowP95Percent
        ) {
          ruleMatches.push(`${code}_LOW_UTILIZATION`);
        }
      }
    }
  }

  const idleCandidate = ruleMatches.includes('CPU_IDLE_CANDIDATE') && blockers.length === 0;
  const strongRightsizing =
    ruleMatches.includes('CPU_STRONG_UNDERUTILIZATION') &&
    ruleMatches.includes('MEMORY_LOW_UTILIZATION') &&
    blockers.length === 0;
  const moderateRightsizing =
    ruleMatches.includes('CPU_MODERATE_UNDERUTILIZATION') &&
    ruleMatches.includes('MEMORY_LOW_UTILIZATION') &&
    blockers.length === 0;

  const readiness: RecommendationReadiness =
    blockers.includes('CPU_SATURATION_RISK') || blockers.includes('MEMORY_SATURATION_RISK')
      ? 'VALIDATION_ONLY'
      : strongRightsizing || moderateRightsizing || idleCandidate
        ? 'GENERATABLE'
        : 'VALIDATION_ONLY';

  const recommendedActionType: TechnicalRecommendedActionType =
    blockers.includes('CPU_SATURATION_RISK') || blockers.includes('MEMORY_SATURATION_RISK')
      ? 'PERFORMANCE_CAPACITY_REVIEW'
      : idleCandidate
        ? 'IDLE_STOP_REVIEW'
        : strongRightsizing || moderateRightsizing
          ? 'RIGHTSIZING'
          : 'TECHNICAL_VALIDATION_REQUIRED';

  const evidenceStrength = isCompute
    ? toEvidenceStrength(summaries, blockers, readiness, referenceDate, ruleConfig)
    : 'LOW';

  return {
    externalResourceId,
    ...(first?.cloudResourceId !== undefined ? { cloudResourceId: first.cloudResourceId } : {}),
    ...(first?.cloudConnectionId !== undefined ? { cloudConnectionId: first.cloudConnectionId } : {}),
    provider: first?.provider ?? 'UNKNOWN',
    ...(first?.resourceType !== undefined ? { resourceType: first.resourceType } : {}),
    ...(first?.serviceName !== undefined ? { serviceName: first.serviceName } : {}),
    readiness,
    evidenceStrength,
    recommendedActionType,
    ruleMatches,
    blockers,
    sourceFacts,
    technicalEvidenceRefs: summaries.map(technicalMetricEvidenceRef),
    metricSummary: summaries.map(toMetricRuleSummary),
    // Utilization rules do not know the target configuration or its price.
    // Keep the legacy field at zero until a deterministic price-difference estimator exists.
    maxTechnicalSavingsRate: 0,
    ruleVersion: ruleConfig.version,
    appliedThresholds: {
      highUtilizationPercent: ruleConfig.highUtilizationPercent,
      cpuCriticalP99Percent: ruleConfig.cpuCriticalP99Percent,
      sustainedHighUtilizationRatio: ruleConfig.sustainedHighUtilizationRatio,
      minimumSamples: ruleConfig.minimumSamples,
      minimumCoverageDays: ruleConfig.minimumCoverageDays,
      recentSampleMaxAgeDays: ruleConfig.recentSampleMaxAgeDays,
    },
  };
}

function hasEnoughCoverage(
  summary: TechnicalMetricSummaryItem,
  referenceDate: Date,
  ruleConfig: TechnicalOptimizationRuleConfig,
): boolean {
  const resolutionSeconds = summary.granularitySeconds;
  // An unknown or invalid source resolution cannot prove 80% coverage.
  if (resolutionSeconds === undefined || resolutionSeconds < 60 || resolutionSeconds > 86400) return false;
  const expected = Math.ceil(7 * 86400 / resolutionSeconds);
  const ageOfFirstMs = referenceDate.getTime() - summary.firstSampledAt.getTime();
  const ageOfLatestMs = referenceDate.getTime() - summary.latestSampledAt.getTime();
  return (
    ageOfFirstMs >= 0 && ageOfFirstMs <= 7 * 86400000 &&
    ageOfLatestMs >= -120000 &&
    summary.sampleCount >= ruleConfig.minimumSamples &&
    summary.coverageDays >= ruleConfig.minimumCoverageDays &&
    summary.sampleCount >= Math.ceil(expected * 0.8) &&
    sampleAgeDays(summary.latestSampledAt, referenceDate) <= ruleConfig.recentSampleMaxAgeDays
  );
}

function toEvidenceStrength(
  summaries: readonly TechnicalMetricSummaryItem[],
  blockers: readonly string[],
  readiness: RecommendationReadiness,
  referenceDate: Date,
  ruleConfig: TechnicalOptimizationRuleConfig,
): TechnicalEvidenceStrength {
  const coveredMetrics = summaries.filter((summary) => hasEnoughCoverage(summary, referenceDate, ruleConfig)).length;
  if (readiness === 'GENERATABLE' && blockers.length === 0 && coveredMetrics >= 2) {
    return 'HIGH';
  }
  if (coveredMetrics > 0) {
    return 'MEDIUM';
  }
  return 'LOW';
}

function findMetric(
  summaries: readonly TechnicalMetricSummaryItem[],
  family: 'cpu' | 'memory' | 'network' | 'disk' | 'iops',
): TechnicalMetricSummaryItem | undefined {
  return summaries.find((summary) => normalizeMetricName(summary.metricName).includes(family));
}

function selectUtilizationMetric(
  summaries: readonly TechnicalMetricSummaryItem[],
  family: 'cpu' | 'memory',
  referenceDate: Date,
  ruleConfig: TechnicalOptimizationRuleConfig,
): { readonly summary?: TechnicalMetricSummaryItem; readonly ambiguous: boolean } {
  const name = family === 'cpu' ? 'cpuutilization' : 'memoryutilization';
  const candidates = summaries.filter((item) =>
    normalizeMetricName(item.metricName) === name
    && item.statistic === 'MEAN'
    && (item.provider !== 'OCI'
      || item.providerNamespace === 'oci_computeagent'
      || (family === 'cpu' && item.providerNamespace === 'oci_vmi_resource_utilization')),
  );
  const covered = candidates.filter((item) => hasEnoughCoverage(item, referenceDate, ruleConfig));
  const pool = covered.length > 0 ? covered : candidates;
  const agent = pool.filter((item) => item.providerNamespace === 'oci_computeagent');
  const preferred = agent.length > 0 ? agent : pool;
  const bestResolution = Math.min(...preferred.map((item) => item.granularitySeconds ?? Number.POSITIVE_INFINITY));
  const available = preferred.filter((item) => (item.granularitySeconds ?? Number.POSITIVE_INFINITY) === bestResolution);
  return { ...(available.length === 1 ? { summary: available[0]! } : {}), ambiguous: available.length > 1 };
}

function normalizeMetricName(metricName: string): string {
  return metricName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPercentMetric(summary: TechnicalMetricSummaryItem): boolean {
  const unit = summary.metricUnit?.toLowerCase().replace(/\s+/g, '') ?? '';
  return unit === '%' || unit === 'percent' || unit === 'percentage';
}

function isHighUtilization(
  summary: TechnicalMetricSummaryItem,
  ruleConfig: TechnicalOptimizationRuleConfig,
): boolean {
  const ratioMatchesSummary = ruleConfig.highUtilizationPercent === 80;
  return summary.p95 >= ruleConfig.highUtilizationPercent
    || (ratioMatchesSummary && (summary.highUtilizationRatio ?? 0) >= ruleConfig.sustainedHighUtilizationRatio);
}

function metricFact(label: string, summary: TechnicalMetricSummaryItem): string {
  return `${label} ${summary.metricName}: avg=${round(summary.avg)}, p95=${round(summary.p95)}, p99=${round(
    summary.p99,
  )}, sobre80=${round(summary.highUtilizationRatio ?? 0) * 100}%, muestras=${summary.sampleCount}, cobertura=${summary.coverageDays} dias.`;
}

function toMetricRuleSummary(summary: TechnicalMetricSummaryItem): TechnicalMetricRuleSummary {
  return {
    metricName: summary.metricName,
    ...(summary.metricUnit !== undefined ? { metricUnit: summary.metricUnit } : {}),
    ...(summary.providerNamespace !== undefined ? { providerNamespace: summary.providerNamespace } : {}),
    ...(summary.regionId !== undefined ? { regionId: summary.regionId } : {}),
    ...(summary.compartmentId !== undefined ? { compartmentId: summary.compartmentId } : {}),
    ...(summary.dimensionsHash !== undefined ? { dimensionsHash: summary.dimensionsHash } : {}),
    statistic: summary.statistic,
    sampleCount: summary.sampleCount,
    ...(summary.granularitySeconds !== undefined ? { granularitySeconds: summary.granularitySeconds } : {}),
    coverageDays: summary.coverageDays,
    avg: round(summary.avg),
    min: round(summary.min),
    max: round(summary.max),
    p50: round(summary.p50),
    p95: round(summary.p95),
    p99: round(summary.p99),
    latest: round(summary.latest),
    highUtilizationSampleCount: summary.highUtilizationSampleCount ?? 0,
    highUtilizationRatio: round(summary.highUtilizationRatio ?? 0),
    firstSampledAt: summary.firstSampledAt.toISOString(),
    latestSampledAt: summary.latestSampledAt.toISOString(),
  };
}

function sampleAgeDays(sampledAt: Date, referenceDate: Date): number {
  return Math.max(0, (referenceDate.getTime() - sampledAt.getTime()) / (24 * 60 * 60 * 1000));
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

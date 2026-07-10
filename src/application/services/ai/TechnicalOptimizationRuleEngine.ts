import type { TechnicalMetricSummaryItem } from '../../../domain/interfaces/IResourceMetricRepository.js';
import type { RecommendationReadiness } from './RecommendationReadinessGate.js';

export type TechnicalEvidenceStrength = 'LOW' | 'MEDIUM' | 'HIGH';

export type TechnicalRecommendedActionType =
  | 'RIGHTSIZING'
  | 'IDLE_STOP_REVIEW'
  | 'PERFORMANCE_CAPACITY_REVIEW'
  | 'TECHNICAL_VALIDATION_REQUIRED';

export interface TechnicalResourceRuleEvaluation {
  readonly externalResourceId: string;
  readonly cloudResourceId?: string;
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
  readonly maxTechnicalSavingsRate: number;
}

export interface TechnicalMetricRuleSummary {
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly sampleCount: number;
  readonly coverageDays: number;
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly latest: number;
  readonly firstSampledAt: string;
  readonly latestSampledAt: string;
}

const minimumSamples = 48;
const minimumCoverageDays = 7;
const recentSampleMaxAgeDays = 7;

export function evaluateTechnicalOptimizationRules(input: {
  readonly summaries: readonly TechnicalMetricSummaryItem[];
  readonly referenceDate: Date;
}): readonly TechnicalResourceRuleEvaluation[] {
  const byResource = groupBy(input.summaries, (summary) => summary.externalResourceId);

  return [...byResource.entries()].map(([externalResourceId, summaries]) =>
    evaluateResource(externalResourceId, summaries, input.referenceDate),
  );
}

function evaluateResource(
  externalResourceId: string,
  summaries: readonly TechnicalMetricSummaryItem[],
  referenceDate: Date,
): TechnicalResourceRuleEvaluation {
  const first = summaries[0];
  const cpu = findMetric(summaries, 'cpu');
  const memory = findMetric(summaries, 'memory');
  const network = findMetric(summaries, 'network');
  const disk = findMetric(summaries, 'disk');
  const iops = findMetric(summaries, 'iops');
  const blockers: string[] = [];
  const ruleMatches: string[] = [];
  const sourceFacts: string[] = [];

  const coverageOk = summaries.some((summary) => hasEnoughCoverage(summary, referenceDate));
  if (!coverageOk) {
    blockers.push('INSUFFICIENT_TECHNICAL_COVERAGE');
  }

  if (cpu === undefined) {
    blockers.push('MISSING_CPU_METRIC');
  } else {
    sourceFacts.push(metricFact('CPU', cpu));
    if (cpu.p95 >= 80 || cpu.p99 >= 90) {
      blockers.push('CPU_SATURATION_RISK');
      ruleMatches.push('CPU_HIGH_UTILIZATION');
    } else if (cpu.avg <= 5 && cpu.p95 <= 10) {
      ruleMatches.push('CPU_IDLE_CANDIDATE');
    } else if (cpu.avg <= 10 && cpu.p95 <= 30) {
      ruleMatches.push('CPU_STRONG_UNDERUTILIZATION');
    } else if (cpu.avg <= 20 && cpu.p95 <= 50) {
      ruleMatches.push('CPU_MODERATE_UNDERUTILIZATION');
    }
  }

  if (memory === undefined) {
    blockers.push('MISSING_MEMORY_METRIC');
  } else {
    sourceFacts.push(metricFact('Memoria', memory));
    if (memory.p95 >= 80) {
      blockers.push('MEMORY_SATURATION_RISK');
      ruleMatches.push('MEMORY_HIGH_UTILIZATION');
    } else if (memory.avg <= 30 && memory.p95 <= 50) {
      ruleMatches.push('MEMORY_LOW_UTILIZATION');
    }
  }

  for (const [label, summary] of [
    ['Red', network],
    ['Disco', disk],
    ['IOPS', iops],
  ] as const) {
    if (summary === undefined) {
      continue;
    }
    sourceFacts.push(metricFact(label, summary));
    if (isPercentMetric(summary) && summary.p95 >= 80) {
      blockers.push(`${label.toUpperCase()}_SATURATION_RISK`);
      ruleMatches.push(`${label.toUpperCase()}_HIGH_UTILIZATION`);
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

  const evidenceStrength = toEvidenceStrength(summaries, blockers, readiness, referenceDate);

  return {
    externalResourceId,
    ...(first?.cloudResourceId !== undefined ? { cloudResourceId: first.cloudResourceId } : {}),
    provider: first?.provider ?? 'UNKNOWN',
    ...(first?.resourceType !== undefined ? { resourceType: first.resourceType } : {}),
    ...(first?.serviceName !== undefined ? { serviceName: first.serviceName } : {}),
    readiness,
    evidenceStrength,
    recommendedActionType,
    ruleMatches,
    blockers,
    sourceFacts,
    technicalEvidenceRefs: summaries.map(
      (summary) =>
        `resource_metric_samples:${summary.externalResourceId}:${summary.metricName}:${summary.latestSampledAt.toISOString()}`,
    ),
    metricSummary: summaries.map(toMetricRuleSummary),
    maxTechnicalSavingsRate: idleCandidate ? 0.4 : strongRightsizing ? 0.25 : moderateRightsizing ? 0.15 : 0,
  };
}

function hasEnoughCoverage(summary: TechnicalMetricSummaryItem, referenceDate: Date): boolean {
  return (
    summary.sampleCount >= minimumSamples &&
    summary.coverageDays >= minimumCoverageDays &&
    sampleAgeDays(summary.latestSampledAt, referenceDate) <= recentSampleMaxAgeDays
  );
}

function toEvidenceStrength(
  summaries: readonly TechnicalMetricSummaryItem[],
  blockers: readonly string[],
  readiness: RecommendationReadiness,
  referenceDate: Date,
): TechnicalEvidenceStrength {
  const coveredMetrics = summaries.filter((summary) => hasEnoughCoverage(summary, referenceDate)).length;
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

function normalizeMetricName(metricName: string): string {
  return metricName.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPercentMetric(summary: TechnicalMetricSummaryItem): boolean {
  return summary.metricUnit?.toLowerCase().includes('percent') === true || summary.max <= 100;
}

function metricFact(label: string, summary: TechnicalMetricSummaryItem): string {
  return `${label} ${summary.metricName}: avg=${round(summary.avg)}, p95=${round(summary.p95)}, p99=${round(
    summary.p99,
  )}, muestras=${summary.sampleCount}, cobertura=${summary.coverageDays} dias.`;
}

function toMetricRuleSummary(summary: TechnicalMetricSummaryItem): TechnicalMetricRuleSummary {
  return {
    metricName: summary.metricName,
    ...(summary.metricUnit !== undefined ? { metricUnit: summary.metricUnit } : {}),
    sampleCount: summary.sampleCount,
    coverageDays: summary.coverageDays,
    avg: round(summary.avg),
    min: round(summary.min),
    max: round(summary.max),
    p50: round(summary.p50),
    p95: round(summary.p95),
    p99: round(summary.p99),
    latest: round(summary.latest),
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

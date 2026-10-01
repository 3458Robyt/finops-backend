import { describe, expect, it } from 'vitest';
import type { TechnicalMetricSummaryItem } from '../../../domain/interfaces/IResourceMetricRepository.js';
import { evaluateTechnicalOptimizationRules } from './TechnicalOptimizationRuleEngine.js';

describe('TechnicalOptimizationRuleEngine', () => {
  const referenceDate = new Date('2026-06-30T00:00:00.000Z');

  it('blocks downsizing when CPU is constantly high', () => {
    const [result] = evaluateTechnicalOptimizationRules({
      referenceDate,
      summaries: [
        summary('cpu_utilization', { avg: 82, p95: 88, p99: 95 }),
        summary('memory_utilization', { avg: 45, p95: 60, p99: 70 }),
      ],
    });

    expect(result?.readiness).toBe('VALIDATION_ONLY');
    expect(result?.recommendedActionType).toBe('PERFORMANCE_CAPACITY_REVIEW');
    expect(result?.blockers).toContain('CPU_SATURATION_RISK');
  });

  it('blocks downsizing when at least one fifth of CPU samples exceed the threshold', () => {
    const [result] = evaluateTechnicalOptimizationRules({
      referenceDate,
      summaries: [
        summary('cpu_utilization', { avg: 35, p95: 70, p99: 75, highUtilizationSampleCount: 24, highUtilizationRatio: 0.25 }),
        summary('memory_utilization', { avg: 40, p95: 60, p99: 70 }),
      ],
    });

    expect(result?.blockers).toContain('CPU_SATURATION_RISK');
    expect(result?.readiness).toBe('VALIDATION_ONLY');
    expect(result?.metricSummary[0]?.highUtilizationRatio).toBe(0.25);
  });

  it('allows strong rightsizing only when CPU and memory are both low', () => {
    const [result] = evaluateTechnicalOptimizationRules({
      referenceDate,
      summaries: [
        summary('cpu_utilization', { avg: 8, p95: 25, p99: 35 }),
        summary('memory_utilization', { avg: 22, p95: 42, p99: 50 }),
      ],
    });

    expect(result?.readiness).toBe('GENERATABLE');
    expect(result?.recommendedActionType).toBe('RIGHTSIZING');
    expect(result?.evidenceStrength).toBe('HIGH');
    expect(result?.maxTechnicalSavingsRate).toBe(0);
    expect(result?.technicalEvidenceRefs[0]).toContain(':MEAN:');
    expect(result?.metricSummary[0]).toMatchObject({ statistic: 'MEAN', granularitySeconds: 3600 });
    expect(result?.ruleMatches).toEqual(
      expect.arrayContaining(['CPU_STRONG_UNDERUTILIZATION', 'MEMORY_LOW_UTILIZATION']),
    );
  });

  it('keeps low CPU as validation-only when memory is missing', () => {
    const [result] = evaluateTechnicalOptimizationRules({
      referenceDate,
      summaries: [summary('cpu_utilization', { avg: 7, p95: 20, p99: 30 })],
    });

    expect(result?.readiness).toBe('VALIDATION_ONLY');
    expect(result?.blockers).toContain('MISSING_MEMORY_METRIC');
  });

  it('downgrades stale or sparse metrics to low evidence', () => {
    const [result] = evaluateTechnicalOptimizationRules({
      referenceDate,
      summaries: [
        summary('cpu_utilization', {
          avg: 8,
          p95: 25,
          p99: 35,
          sampleCount: 12,
          coverageDays: 2,
          latestSampledAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
        summary('memory_utilization', {
          avg: 20,
          p95: 35,
          p99: 45,
          sampleCount: 12,
          coverageDays: 2,
          latestSampledAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      ],
    });

    expect(result?.readiness).toBe('VALIDATION_ONLY');
    expect(result?.evidenceStrength).toBe('LOW');
    expect(result?.blockers).toContain('INSUFFICIENT_TECHNICAL_COVERAGE');
  });

  it('does not treat non-utilization values below 100 as percentage saturation', () => {
    const result = evaluateTechnicalOptimizationRules({
      referenceDate,
      summaries: [
        summary('NetworkBytesIn', {
          metricUnit: 'Bytes',
          avg: 70,
          p95: 95,
          p99: 99,
          max: 99,
          highUtilizationSampleCount: 0,
          highUtilizationRatio: 0,
        }),
        summary('CpuUtilization', { avg: 12, p95: 35, p99: 45 }),
        summary('MemoryUtilization', { avg: 24, p95: 45, p99: 55 }),
      ],
    });

    expect(result[0]?.blockers).not.toContain('NETWORK_SATURATION_RISK');
    expect(result[0]?.ruleMatches).not.toContain('NETWORK_HIGH_UTILIZATION');
  });

  it('records the rule version and detects low auxiliary utilization', () => {
    const [result] = evaluateTechnicalOptimizationRules({
      referenceDate,
      summaries: [
        summary('NetworkUtilization', { avg: 8, p95: 20 }),
        summary('DiskUtilization', { avg: 12, p95: 30 }),
        summary('CpuUtilization', { avg: 35, p95: 65, p99: 70 }),
        summary('MemoryUtilization', { avg: 45, p95: 65, p99: 70 }),
      ],
    });

    expect(result?.ruleVersion).toBe('technical-rules-2026-09-27.v2');
    expect(result?.appliedThresholds).toMatchObject({
      highUtilizationPercent: 80,
      minimumSamples: 48,
      minimumCoverageDays: 7,
    });
    expect(result?.ruleMatches).toEqual(expect.arrayContaining(['NETWORK_LOW_UTILIZATION', 'DISK_LOW_UTILIZATION']));
  });

  it('does not interpret absolute CPU or memory values as percentages', () => {
    const [result] = evaluateTechnicalOptimizationRules({
      referenceDate,
      summaries: [
        summary('CpuUtilization', { metricUnit: 'Seconds', avg: 1, p95: 2, p99: 3 }),
        summary('MemoryUtilization', { metricUnit: 'Bytes', avg: 10, p95: 20, p99: 30 }),
      ],
    });

    expect(result?.readiness).toBe('VALIDATION_ONLY');
    expect(result?.ruleMatches).not.toEqual(expect.arrayContaining([
      'CPU_IDLE_CANDIDATE',
      'CPU_STRONG_UNDERUTILIZATION',
      'MEMORY_LOW_UTILIZATION',
    ]));
    expect(result?.blockers).toEqual(expect.arrayContaining([
      'CPU_METRIC_UNIT_NOT_PERCENTAGE',
      'MEMORY_METRIC_UNIT_NOT_PERCENTAGE',
    ]));
  });

  it('requires verified OCI namespace, MEAN statistic and percentage unit', () => {
    const cpu = summary('CpuUtilization', { provider: 'OCI', providerNamespace: 'oci_computeagent', statistic: 'MEAN' });
    const memory = summary('MemoryUtilization', { provider: 'OCI', providerNamespace: 'oci_computeagent', statistic: 'MEAN' });
    const [wrongSource] = evaluateTechnicalOptimizationRules({ referenceDate, summaries: [
      { ...cpu, providerNamespace: undefined }, memory,
    ] });
    expect(wrongSource?.blockers).toContain('MISSING_CPU_METRIC');
    const [wrongStatistic] = evaluateTechnicalOptimizationRules({ referenceDate, summaries: [
      { ...cpu, statistic: 'MAX' }, memory,
    ] });
    expect(wrongStatistic?.blockers).toContain('MISSING_CPU_METRIC');
    const [unknownUnit] = evaluateTechnicalOptimizationRules({ referenceDate, summaries: [
      { ...cpu, metricUnit: undefined }, memory,
    ] });
    expect(unknownUnit?.blockers).toContain('CPU_METRIC_UNIT_NOT_PERCENTAGE');
    expect(unknownUnit?.readiness).toBe('VALIDATION_ONLY');
  });

  it('requires complete CPU and memory coverage separately', () => {
    const [result] = evaluateTechnicalOptimizationRules({ referenceDate, summaries: [
      summary('CpuUtilization', { avg: 8, p95: 25 }),
      summary('MemoryUtilization', { avg: 20, p95: 35, sampleCount: 48, coverageDays: 7 }),
    ] });
    expect(result?.readiness).toBe('VALIDATION_ONLY');
    expect(result?.blockers).toContain('INSUFFICIENT_TECHNICAL_COVERAGE');
  });

  it('rejects a nominally complete summary drawn from older than seven days or future data', () => {
    const cpu = summary('CpuUtilization', { avg: 8, p95: 25 });
    const memory = summary('MemoryUtilization', { avg: 20, p95: 35 });
    const [old] = evaluateTechnicalOptimizationRules({ referenceDate, summaries: [
      { ...cpu, firstSampledAt: new Date('2026-06-20T00:00:00.000Z') }, memory,
    ] });
    expect(old?.blockers).toContain('INSUFFICIENT_TECHNICAL_COVERAGE');
    const [future] = evaluateTechnicalOptimizationRules({ referenceDate, summaries: [
      { ...cpu, latestSampledAt: new Date('2026-07-02T00:00:00.000Z') }, memory,
    ] });
    expect(future?.readiness).toBe('VALIDATION_ONLY');
  });

  it('does not pick an arbitrary duplicate CPU stream or apply Compute rules to storage', () => {
    const cpu = summary('CpuUtilization', { avg: 8, p95: 25 });
    const memory = summary('MemoryUtilization', { avg: 20, p95: 35 });
    const [ambiguous] = evaluateTechnicalOptimizationRules({ referenceDate, summaries: [
      cpu, { ...cpu, dimensionsHash: 'other' }, memory,
    ] });
    expect(ambiguous?.blockers).toContain('AMBIGUOUS_CPU_STREAM');
    expect(ambiguous?.readiness).toBe('VALIDATION_ONLY');
    const [storage] = evaluateTechnicalOptimizationRules({ referenceDate, summaries: [
      { ...cpu, resourceType: 'BLOCK_VOLUME' }, { ...memory, resourceType: 'BLOCK_VOLUME' },
    ] });
    expect(storage?.blockers).toContain('UNSUPPORTED_RESOURCE_TYPE');
    expect(storage?.blockers).not.toContain('MISSING_CPU_METRIC');
    const [storageWithoutCpu] = evaluateTechnicalOptimizationRules({ referenceDate, summaries: [
      { ...memory, resourceType: 'BLOCK_VOLUME' },
    ] });
    expect(storageWithoutCpu?.blockers).toEqual(['UNSUPPORTED_RESOURCE_TYPE']);
  });
});

function summary(
  metricName: string,
  overrides: Partial<TechnicalMetricSummaryItem>,
): TechnicalMetricSummaryItem {
  return {
    provider: 'AWS',
    externalResourceId: 'i-prod-1',
    cloudResourceId: 'cloud-resource-1',
    resourceType: 'COMPUTE_INSTANCE',
    serviceName: 'Amazon EC2',
    metricName,
    statistic: 'MEAN',
    metricUnit: 'Percent',
    sampleCount: 168,
    coverageDays: 7,
    granularitySeconds: 3600,
    min: 1,
    max: overrides.p99 ?? 40,
    avg: overrides.avg ?? 10,
    p50: overrides.avg ?? 10,
    p95: overrides.p95 ?? 25,
    p99: overrides.p99 ?? 35,
    latest: overrides.avg ?? 10,
    firstSampledAt: new Date('2026-06-23T00:00:00.000Z'),
    latestSampledAt: new Date('2026-06-29T00:00:00.000Z'),
    ...overrides,
  };
}

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
    metricUnit: 'Percent',
    sampleCount: 96,
    coverageDays: 14,
    min: 1,
    max: overrides.p99 ?? 40,
    avg: overrides.avg ?? 10,
    p50: overrides.avg ?? 10,
    p95: overrides.p95 ?? 25,
    p99: overrides.p99 ?? 35,
    latest: overrides.avg ?? 10,
    firstSampledAt: new Date('2026-06-16T00:00:00.000Z'),
    latestSampledAt: new Date('2026-06-29T00:00:00.000Z'),
    ...overrides,
  };
}

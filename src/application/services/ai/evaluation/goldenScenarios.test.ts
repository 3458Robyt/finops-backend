import { describe, expect, test } from 'vitest';
import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { AiRecommendationDraft } from '../finOpsAiTypes.js';
import { goldenScenarios } from './goldenScenarios.js';
import { runScenarioOffline } from './goldenScenarioRunner.js';
import { evaluateExecutionPlan, evaluateRecommendationDrafts } from './qualityRubric.js';
import type { RecommendationEvidenceSnapshot } from '../RecommendationEvidenceSnapshot.js';

const snapshot: CostAnalyticsSnapshot = {
  tenantId: 'tenant-demo',
  periodStart: '2026-04-01',
  periodEnd: '2026-05-01',
  totalCost: 1000,
  currency: 'USD',
  metricCount: 5000,
  providers: [{ provider: 'AWS', totalCost: 1000, metricCount: 5000 }],
  accounts: [
    { cloudAccountId: 'acc-prod-aws', provider: 'AWS', name: 'Prod', totalCost: 700, metricCount: 3000 },
  ],
  services: [{ serviceName: 'Amazon S3', provider: 'AWS', totalCost: 420, metricCount: 1500 }],
  environments: [],
  topResources: [],
};

function draft(overrides: Partial<AiRecommendationDraft> = {}): AiRecommendationDraft {
  return {
    cloudAccountId: 'acc-prod-aws',
    type: 'STORAGE_LIFECYCLE',
    severity: 'MEDIUM',
    title: 'Optimizar S3',
    description: 'Aplicar ciclo de vida a objetos antiguos.',
    evidence: { evidenceLevel: 'COST_AND_USAGE' },
    estimatedMonthlySavings: 80,
    currency: 'USD',
    ...overrides,
  };
}

describe('golden scenarios (offline)', () => {
  test('every golden scenario matches its expected outcome', () => {
    for (const scenario of goldenScenarios) {
      const result = runScenarioOffline(scenario);
      expect(result.matchedExpectation, `${scenario.name} → ${result.outcome}`).toBe(true);
    }
  });
});

describe('qualityRubric — recommendations', () => {
  test('passes a well-formed cost-and-usage recommendation', () => {
    const report = evaluateRecommendationDrafts([draft()], snapshot);
    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
  });

  test('fails account scoping when cloudAccountId is not in the snapshot', () => {
    const report = evaluateRecommendationDrafts([draft({ cloudAccountId: 'acc-ghost' })], snapshot);
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === 'accountScoping')?.passed).toBe(false);
  });

  test('fails focus honesty when COST_ONLY does not require technical validation', () => {
    const report = evaluateRecommendationDrafts(
      [draft({ evidence: { evidenceLevel: 'COST_ONLY' } })],
      snapshot,
    );
    expect(report.checks.find((check) => check.name === 'focusHonesty')?.passed).toBe(false);
  });

  test('passes focus honesty when COST_ONLY requires technical validation', () => {
    const report = evaluateRecommendationDrafts(
      [draft({ evidence: { evidenceLevel: 'COST_ONLY', requiresTechnicalValidation: true } })],
      snapshot,
    );
    expect(report.checks.find((check) => check.name === 'focusHonesty')?.passed).toBe(true);
  });

  test('fails savings realism when savings exceed the total cost', () => {
    const report = evaluateRecommendationDrafts([draft({ estimatedMonthlySavings: 999999 })], snapshot);
    expect(report.checks.find((check) => check.name === 'savingsRealism')?.passed).toBe(false);
  });

  test('rejects a recommendation that targets a different resource in a scoped analysis', () => {
    const report = evaluateRecommendationDrafts(
      [draft({ evidence: { evidenceLevel: 'COST_AND_USAGE', externalResourceId: 'i-other' } })],
      snapshot,
      undefined,
      'i-requested',
    );

    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === 'resourceScoping')?.passed).toBe(false);
  });

  test('accepts a recommendation that targets exactly the scoped resource', () => {
    const report = evaluateRecommendationDrafts(
      [draft({ evidence: { evidenceLevel: 'COST_AND_USAGE', externalResourceId: 'i-requested' } })],
      snapshot,
      undefined,
      'i-requested',
    );

    expect(report.checks.find((check) => check.name === 'resourceScoping')?.passed).toBe(true);
  });

  test('requires a technical recommendation to cite the canonical snapshot exactly', () => {
    const report = evaluateRecommendationDrafts([
      draft({
        type: 'RIGHTSIZING',
        estimatedMonthlySavings: 40,
        evidence: {
          evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
          externalResourceId: 'i-requested',
          cloudResourceId: 'resource-1',
          technicalEvidenceRefs: ['resource_metric_samples:i-requested:CpuUtilization:2026-04-30T00:00:00.000Z'],
          technicalSampleCount: 96,
          technicalCoverageDays: 14,
          latestTechnicalSampleAt: '2026-04-30T00:00:00.000Z',
        },
      }),
    ], snapshot, undefined, undefined, buildCanonicalEvidenceSnapshot());

    expect(report.passed).toBe(true);
    expect(report.checks.find((check) => check.name === 'canonicalTechnicalEvidence')?.passed).toBe(true);
  });

  test('rejects an invented metric reference even when the auditor would approve it', () => {
    const report = evaluateRecommendationDrafts([
      draft({
        type: 'RIGHTSIZING',
        evidence: {
          evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
          externalResourceId: 'i-requested',
          cloudResourceId: 'resource-1',
          technicalEvidenceRefs: ['resource_metric_samples:i-requested:MemoryUtilization:invented'],
          technicalSampleCount: 96,
          technicalCoverageDays: 14,
          latestTechnicalSampleAt: '2026-04-30T00:00:00.000Z',
        },
      }),
    ], snapshot, undefined, undefined, buildCanonicalEvidenceSnapshot());

    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === 'canonicalTechnicalEvidence')?.passed).toBe(false);
  });

  test('rejects technical counts or savings that differ from the canonical snapshot', () => {
    const report = evaluateRecommendationDrafts([
      draft({
        type: 'RIGHTSIZING',
        estimatedMonthlySavings: 999,
        evidence: {
          evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
          externalResourceId: 'i-requested',
          cloudResourceId: 'resource-1',
          technicalEvidenceRefs: ['resource_metric_samples:i-requested:CpuUtilization:2026-04-30T00:00:00.000Z'],
          technicalSampleCount: 95,
          technicalCoverageDays: 14,
          latestTechnicalSampleAt: '2026-04-30T00:00:00.000Z',
        },
      }),
    ], snapshot, undefined, undefined, buildCanonicalEvidenceSnapshot());

    expect(report.checks.find((check) => check.name === 'canonicalTechnicalEvidence')?.passed).toBe(false);
  });
});

function buildCanonicalEvidenceSnapshot(): RecommendationEvidenceSnapshot {
  const rule = {
    externalResourceId: 'i-requested',
    cloudResourceId: 'resource-1',
    provider: 'AWS',
    readiness: 'GENERATABLE' as const,
    evidenceStrength: 'HIGH' as const,
    recommendedActionType: 'RIGHTSIZING' as const,
    ruleMatches: ['CPU_STRONG_UNDERUTILIZATION', 'MEMORY_LOW_UTILIZATION'],
    blockers: [],
    sourceFacts: ['CPU baja y memoria baja con cobertura suficiente.'],
    technicalEvidenceRefs: ['resource_metric_samples:i-requested:CpuUtilization:2026-04-30T00:00:00.000Z'],
    metricSummary: [],
    maxTechnicalSavingsRate: 0.25,
  };
  return {
    version: '1',
    hash: 'canonical-test-hash',
    tenantId: 'tenant-demo',
    periodStart: '2026-04-01',
    periodEnd: '2026-05-01',
    generatedAt: '2026-05-01T00:00:00.000Z',
    availability: 'COST_USAGE_AND_TECHNICAL_AVAILABLE',
    resources: [{
      externalResourceId: 'i-requested',
      cloudResourceId: 'resource-1',
      provider: 'AWS',
      linkQuality: 'COST_AND_TECHNICAL',
      cost: { totalCost: 200, currency: 'USD', focusMetricCount: 40 },
      usage: [],
      metrics: [{
        metricName: 'CpuUtilization',
        metricUnit: 'Percent',
        sampleCount: 96,
        coverageDays: 14,
        min: 1,
        max: 25,
        avg: 8,
        p50: 8,
        p95: 15,
        p99: 25,
        latest: 8,
        firstSampledAt: '2026-04-16T00:00:00.000Z',
        latestSampledAt: '2026-04-30T00:00:00.000Z',
        evidenceRef: 'resource_metric_samples:i-requested:CpuUtilization:2026-04-30T00:00:00.000Z',
      }],
      ruleEvaluation: rule,
    }],
    deterministicRules: [rule],
  };
}

describe('qualityRubric — execution plan', () => {
  const validPlan: Record<string, unknown> = {
    summary: 'Plan manual de optimización de S3.',
    scope: { cloudAccountId: 'acc-prod-aws', service: 'Amazon S3' },
    prerequisites: ['Confirmar ventana de cambio.'],
    steps: ['Configurar regla de ciclo de vida.'],
    validation: ['Comparar costo antes y después.'],
    risks: ['Recuperación más lenta de objetos archivados.'],
    rollback: ['Eliminar la regla de ciclo de vida.'],
    successCriteria: ['Reducción de costo de almacenamiento.'],
  };

  test('passes a complete manual plan scoped to a real account', () => {
    expect(evaluateExecutionPlan(validPlan, snapshot).passed).toBe(true);
  });

  test('fails when the plan promises automatic execution', () => {
    const autoPlan = { ...validPlan, steps: ['El sistema ejecutara automaticamente el cambio en AWS.'] };
    const report = evaluateExecutionPlan(autoPlan, snapshot);
    expect(report.checks.find((check) => check.name === 'noAutoExecution')?.passed).toBe(false);
  });

  test('fails when a required section is missing', () => {
    const { rollback: _omitted, ...incomplete } = validPlan;
    const report = evaluateExecutionPlan(incomplete, snapshot);
    expect(report.checks.find((check) => check.name === 'requiredArrays')?.passed).toBe(false);
  });
});

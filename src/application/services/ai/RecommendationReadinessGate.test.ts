import { describe, expect, it } from 'vitest';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import {
  buildRecommendationReadinessReport,
  formatRecommendationReadinessForPrompt,
} from './RecommendationReadinessGate.js';

describe('RecommendationReadinessGate', () => {
  it('marks resource cost opportunities as validation-only when technical evidence is missing', () => {
    const report = buildRecommendationReadinessReport({ snapshot: buildSnapshot() });

    const resourceCandidate = report.candidates.find((candidate) => candidate.id === 'resource-1');

    expect(resourceCandidate?.readiness).toBe('VALIDATION_ONLY');
    expect(resourceCandidate?.requiresTechnicalValidation).toBe(true);
    expect(resourceCandidate?.evidenceLevelAllowed).toBe('COST_ONLY');
    expect(resourceCandidate?.forbiddenClaims.join(' ')).toContain('rightsizing');
  });

  it('allows technical recommendations only when a resource has technical evidence refs', () => {
    const report = buildRecommendationReadinessReport({
      snapshot: buildSnapshot(),
      technicalEvidence:
        '{"resources":[{"externalResourceId":"i-prod-1","technicalEvidenceRefs":["resource_metric_samples:i-prod-1:CPUUtilization:2026-06"]}]}',
    });

    const resourceCandidate = report.candidates.find((candidate) => candidate.id === 'resource-1');

    expect(resourceCandidate?.readiness).toBe('GENERATABLE');
    expect(resourceCandidate?.requiresTechnicalValidation).toBe(false);
    expect(resourceCandidate?.evidenceLevelAllowed).toBe('COST_USAGE_AND_TECHNICAL');
    expect(resourceCandidate?.technicalEvidenceRefs).toEqual([
      'resource_metric_samples:i-prod-1:CPUUtilization:2026-06',
    ]);
  });

  it('keeps a resource validation-only when deterministic rules report blockers', () => {
    const report = buildRecommendationReadinessReport({
      snapshot: buildSnapshot(),
      technicalEvidence: [
        'Evidencia tecnica real disponible:',
        JSON.stringify({
          deterministicRules: [
            {
              externalResourceId: 'i-prod-1',
              readiness: 'VALIDATION_ONLY',
              evidenceStrength: 'HIGH',
              recommendedActionType: 'PERFORMANCE_CAPACITY_REVIEW',
              ruleMatches: ['CPU_HIGH_UTILIZATION'],
              blockers: ['CPU_SATURATION_RISK'],
              sourceFacts: ['CPU cpu_utilization: avg=82, p95=88, p99=95, muestras=96, cobertura=14 dias.'],
              technicalEvidenceRefs: ['resource_metric_samples:i-prod-1:CPUUtilization:2026-06'],
              maxTechnicalSavingsRate: 0,
            },
          ],
        }),
      ].join('\n'),
    });

    const resourceCandidate = report.candidates.find((candidate) => candidate.id === 'resource-1');

    expect(resourceCandidate?.readiness).toBe('VALIDATION_ONLY');
    expect(resourceCandidate?.opportunityType).toBe('PERFORMANCE_CAPACITY_REVIEW');
    expect(resourceCandidate?.blockers).toContain('CPU_SATURATION_RISK');
    expect(resourceCandidate?.maxEstimatedMonthlySavings).toBe(0);
  });

  it('serializes prompt instructions with max savings and validation constraints', () => {
    const promptBlock = formatRecommendationReadinessForPrompt(
      buildRecommendationReadinessReport({ snapshot: buildSnapshot() }),
    );

    expect(promptBlock).toContain('maxEstimatedMonthlySavings');
    expect(promptBlock).toContain('VALIDATION_ONLY');
    expect(promptBlock).toContain('estimatedMonthlySavings no puede superar');
  });
});

function buildSnapshot(): CostAnalyticsSnapshot {
  return {
    tenantId: 'tenant-1',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-06-30T00:00:00.000Z',
    totalCost: 500,
    currency: 'USD',
    metricCount: 120,
    providers: [{ provider: 'AWS', totalCost: 500, metricCount: 120 }],
    accounts: [
      {
        cloudAccountId: 'aws-prod',
        provider: 'AWS',
        name: 'AWS Produccion',
        totalCost: 500,
        metricCount: 120,
      },
    ],
    services: [{ serviceName: 'Amazon EC2', provider: 'AWS', totalCost: 500, metricCount: 120 }],
    environments: [],
    topResources: [
      {
        resourceId: 'i-prod-1',
        serviceName: 'Amazon EC2',
        provider: 'AWS',
        totalCost: 300,
        metricCount: 80,
      },
    ],
    topUsage: [
      {
        serviceName: 'Amazon EC2',
        provider: 'AWS',
        consumedQuantity: 720,
        consumedUnit: 'Hours',
        totalCost: 500,
        unitCost: 0.69,
        currency: 'USD',
        metricCount: 120,
      },
    ],
  };
}

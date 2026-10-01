import { describe, expect, it } from 'vitest';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import {
  buildRecommendationReadinessReport,
  formatRecommendationReadinessForPrompt,
} from './RecommendationReadinessGate.js';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type { TechnicalResourceRuleEvaluation } from './TechnicalOptimizationRuleEngine.js';
import { evaluateRecommendationDrafts } from './evaluation/recommendationQualityChecks.js';
import type { AiRecommendationDraft } from './finOpsAiTypes.js';

describe('RecommendationReadinessGate', () => {
  it('keeps resource candidates validation-only and out of generation when technical evidence is missing', () => {
    const report = buildRecommendationReadinessReport({ snapshot: buildSnapshot() });

    const resourceCandidate = report.blocked.find((candidate) => candidate.id === 'resource-1');

    expect(resourceCandidate?.readiness).toBe('VALIDATION_ONLY');
    expect(report.candidates.some((candidate) => candidate.id === 'resource-1')).toBe(false);
    expect(resourceCandidate?.requiresTechnicalValidation).toBe(true);
    expect(resourceCandidate?.evidenceLevelAllowed).toBe('COST_ONLY');
    expect(resourceCandidate?.maxEstimatedMonthlySavings).toBe(0);
    expect(resourceCandidate?.forbiddenClaims.join(' ')).toContain('rightsizing');
  });

  it('does not infer savings from billed consumption or service cost alone', () => {
    const report = buildRecommendationReadinessReport({ snapshot: buildSnapshot() });

    expect(report.blocked.find((candidate) => candidate.id === 'usage-1')?.maxEstimatedMonthlySavings).toBe(0);
    expect(report.blocked.find((candidate) => candidate.id === 'resource-1')?.maxEstimatedMonthlySavings).toBe(0);
    expect(report.blocked.find((candidate) => candidate.id === 'service-1')?.maxEstimatedMonthlySavings).toBe(0);
  });

  it('blocks top-consumption and service-cost candidates without an evidenced saving mechanism', () => {
    const report = buildRecommendationReadinessReport({ snapshot: buildSnapshot() });

    expect(report.candidates.some((candidate) => candidate.id === 'usage-1')).toBe(false);
    expect(report.candidates.some((candidate) => candidate.id === 'service-1')).toBe(false);
    expect(report.blocked.find((candidate) => candidate.id === 'usage-1')?.readiness).toBe('BLOCKED_NO_EVIDENCE');
    expect(report.blocked.find((candidate) => candidate.id === 'service-1')?.readiness).toBe('BLOCKED_NO_EVIDENCE');
    expect(report.blocked.find((candidate) => candidate.id === 'usage-1')?.reasons.join(' ')).toMatch(/demuestra|ahorro/i);
  });

  it('rejects a quantified savings claim in prose when no priced alternative is available', () => {
    const baseReadiness = buildRecommendationReadinessReport({ snapshot: buildSnapshot() });
    const blockedUsage = baseReadiness.blocked.find((item) => item.id === 'usage-1')!;
    const candidate = { ...blockedUsage, readiness: 'GENERATABLE' as const };
    const readiness = {
      ...baseReadiness,
      candidates: [...baseReadiness.candidates, candidate],
      blocked: baseReadiness.blocked.filter((item) => item.id !== 'usage-1'),
    };
    const draft: AiRecommendationDraft = {
      cloudAccountId: candidate.cloudAccountId,
      type: candidate.opportunityType,
      severity: 'MEDIUM',
      title: 'Ahorrar 6.514 COP mensuales en el servicio',
      description: 'Revisar el costo y consumo observado.',
      currency: candidate.currency,
      evidence: {
        candidateId: candidate.id,
        evidenceLevel: candidate.evidenceLevelAllowed,
        requiresTechnicalValidation: candidate.requiresTechnicalValidation,
        observedCost: candidate.observedCost,
        normalizedMonthlyCost: 500,
        maxEstimatedMonthlySavings: candidate.maxEstimatedMonthlySavings,
      },
    };

    const quality = evaluateRecommendationDrafts([draft], buildSnapshot(), undefined, undefined, undefined, readiness);

    expect(quality.checks.find((check) => check.name === 'savingsNarrativeCap')?.passed).toBe(false);
  });

  it('allows technical recommendations only when a resource has technical evidence refs', () => {
    const report = buildRecommendationReadinessReport({
      snapshot: buildSnapshot(),
      technicalEvidenceSnapshot: buildEvidenceSnapshot(),
    });

    const resourceCandidate = report.candidates.find((candidate) => candidate.id === 'resource-1');

    expect(resourceCandidate?.readiness).toBe('GENERATABLE');
    expect(resourceCandidate?.requiresTechnicalValidation).toBe(true);
    expect(resourceCandidate?.evidenceLevelAllowed).toBe('COST_USAGE_AND_TECHNICAL');
    expect(resourceCandidate?.maxEstimatedMonthlySavings).toBe(0);
    expect(resourceCandidate?.savingsCalculation).toBeUndefined();
    expect(resourceCandidate?.technicalEvidenceRefs).toEqual([
      'resource_metric_samples:i-prod-1:CPUUtilization:2026-06',
    ]);
  });

  it('blocks technical-only or stale cost evidence and explains the missing price', () => {
    const evidence = buildEvidenceSnapshot();
    const technicalOnly = buildRecommendationReadinessReport({
      snapshot: buildSnapshot(),
      technicalEvidenceSnapshot: { ...evidence, resources: [{ ...evidence.resources[0]!, linkQuality: 'TECHNICAL_ONLY' }] },
    });
    expect(technicalOnly.candidates).toHaveLength(0);
    expect(technicalOnly.blocked.find((item) => item.id === 'resource-1')?.evidenceIssues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'NO_LINKED_TECHNICAL_METRICS' })]));

    const stale = buildRecommendationReadinessReport({
      snapshot: { ...buildSnapshot(), periodEnd: '2026-06-01T00:00:00.000Z' },
      technicalEvidenceSnapshot: evidence,
    });
    expect(stale.blocked.find((item) => item.id === 'resource-1')?.evidenceIssues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'STALE_COST' })]));
    const priced = buildRecommendationReadinessReport({ snapshot: buildSnapshot(), technicalEvidenceSnapshot: evidence });
    expect(priced.candidates[0]?.evidenceIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNPRICED_ALTERNATIVE' }),
    ]));
    expect(priced.candidates[0]?.maxEstimatedMonthlySavings).toBe(0);
  });

  it('fails closed when the raw technical stream catalog is truncated', () => {
    const report = buildRecommendationReadinessReport({
      snapshot: buildSnapshot(),
      technicalEvidenceSnapshot: { ...buildEvidenceSnapshot(), summaryTruncated: true },
    });
    expect(report.candidates).toHaveLength(0);
    expect(report.blocked.find((item) => item.id === 'resource-1')?.evidenceIssues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'EVIDENCE_QUERY_LIMIT_REACHED' })]));
  });

  it('does not offer savings for a resource without positive attributable cost', () => {
    const snapshot = buildSnapshot();
    const report = buildRecommendationReadinessReport({
      snapshot: { ...snapshot, topResources: [{ ...snapshot.topResources[0]!, totalCost: 0 }] },
      technicalEvidenceSnapshot: buildEvidenceSnapshot(),
    });
    expect(report.candidates).toHaveLength(0);
    expect(report.blocked.find((item) => item.id === 'resource-1')?.evidenceIssues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'NO_CHARGEABLE_COST' })]));
  });

  it('prioritizes at most five review-only candidates by deterministic signals and normalized spend', () => {
    const now = new Date();
    const periodStart = new Date(now.getTime() - 30 * 86400000).toISOString();
    const periodEnd = now.toISOString();
    const resources = Array.from({ length: 7 }, (_, index) => ({
      ...buildSnapshot().topResources[0]!,
      resourceId: `instance-${index + 1}`,
      cloudAccountId: 'aws-prod',
      totalCost: 700 - index * 100,
    }));
    const report = buildRecommendationReadinessReport({
      snapshot: { ...buildSnapshot(), periodStart, periodEnd, observedThrough: periodEnd, topResources: resources },
    });

    expect(report.candidates).toHaveLength(0);
    expect(report.reviewCandidates).toHaveLength(5);
    expect(report.reviewCandidates.map((candidate) => candidate.resourceId)).toEqual([
      'instance-1', 'instance-2', 'instance-3', 'instance-4', 'instance-5',
    ]);
    expect(report.reviewCandidates.every((candidate) => candidate.maxEstimatedMonthlySavings === 0)).toBe(true);
    expect(report.summary).toContain('borradores de revisión técnica');
  });

  it('does not suggest CPU or memory review drafts for non-Compute resources', () => {
    const snapshot = buildSnapshot();
    const report = buildRecommendationReadinessReport({
      snapshot: { ...snapshot, topResources: [{ ...snapshot.topResources[0]!, serviceName: 'Amazon S3' }] },
    });

    expect(report.blocked.find((candidate) => candidate.id === 'resource-1')).toBeDefined();
    expect(report.reviewCandidates).toEqual([]);
  });

  it('keeps canonical cost scope server-side and out of the model prompt', () => {
    const snapshot = buildSnapshot();
    const technicalEvidenceSnapshot = buildEvidenceSnapshot();
    const report = buildRecommendationReadinessReport({
      snapshot: {
        ...snapshot,
        topResources: [{
          ...snapshot.topResources[0]!,
          cloudResourceId: 'cloud-resource-1',
          cloudConnectionId: 'connection-1',
        }],
      },
      technicalEvidenceSnapshot: {
        ...technicalEvidenceSnapshot,
        resources: [{
          ...technicalEvidenceSnapshot.resources[0]!,
          cloudResourceId: 'cloud-resource-1',
          cloudConnectionId: 'connection-1',
        }],
      },
    });
    const candidate = report.candidates.find((item) => item.id === 'resource-1')!;

    expect(candidate.costEvidenceScope).toMatchObject({
      cloudAccountId: 'aws-prod',
      cloudResourceId: 'cloud-resource-1',
      cloudConnectionId: 'connection-1',
      expectedMetricCount: 80,
    });
    expect(JSON.parse(formatRecommendationReadinessForPrompt(report)).candidates[0])
      .not.toHaveProperty('costEvidenceScope');
  });

  it('blocks service cost reviews without a deterministic savings basis', () => {
    const report = buildRecommendationReadinessReport({ snapshot: buildSnapshot() });
    const serviceCandidate = report.blocked.find((candidate) => candidate.id === 'service-1');
    const usageCandidate = report.blocked.find((candidate) => candidate.id === 'usage-1');

    expect(serviceCandidate?.readiness).toBe('BLOCKED_NO_EVIDENCE');
    expect(serviceCandidate?.requiresTechnicalValidation).toBe(false);
    expect(serviceCandidate?.evidenceLevelAllowed).toBe('COST_ONLY');
    expect(serviceCandidate?.reviewScope).toBe('FINANCIAL');
    expect(serviceCandidate?.costEvidenceRefs[0]).toContain(':service:AWS:aws-prod:Amazon EC2');
    expect(usageCandidate?.costEvidenceRefs[0]).toContain(':usage:AWS:aws-prod:Amazon EC2');
  });

  it('does not assign provider-aggregated candidates to an arbitrary account when multiple accounts match', () => {
    const snapshot = buildSnapshot();
    const report = buildRecommendationReadinessReport({
      snapshot: {
        ...snapshot,
        accounts: [
          ...snapshot.accounts,
          { ...snapshot.accounts[0]!, cloudAccountId: 'aws-dev', name: 'AWS Desarrollo' },
        ],
      },
    });

    for (const id of ['usage-1', 'service-1']) {
      const candidate = report.blocked.find((item) => item.id === id)!;
      expect(candidate.cloudAccountId).toBe('unknown-account');
      expect(candidate.reasons.join(' ')).toContain('cuenta cloud única');
      expect(candidate.costEvidenceRefs[0]).toContain(':unknown-account:');
    }
  });

  it('does not fall back to an unrelated provider account for aggregate candidates', () => {
    const snapshot = buildSnapshot();
    const report = buildRecommendationReadinessReport({
      snapshot: {
        ...snapshot,
        services: snapshot.services.map((item) => ({ ...item, provider: 'OCI' })),
        topUsage: snapshot.topUsage?.map((item) => ({ ...item, provider: 'OCI' })),
      },
    });

    for (const id of ['usage-1', 'service-1']) {
      const candidate = report.blocked.find((item) => item.id === id)!;
      expect(candidate.cloudAccountId).toBe('unknown-account');
      expect(candidate.reasons.join(' ')).toContain('cuenta cloud única');
      expect(candidate.costEvidenceRefs[0]).toContain(':OCI:unknown-account:');
    }
  });

  it('blocks duplicate external ids until a canonical resource is selected', () => {
    const first = buildEvidenceSnapshot({ cloudResourceId: 'cloud-a', cloudConnectionId: 'connection-a' });
    const second = buildEvidenceSnapshot({ cloudResourceId: 'cloud-b', cloudConnectionId: 'connection-b' });
    const report = buildRecommendationReadinessReport({
      snapshot: buildSnapshot(),
      technicalEvidenceSnapshot: {
        ...first,
        resources: [...first.resources, { ...second.resources[0]! }],
        deterministicRules: [...first.deterministicRules, { ...second.deterministicRules[0]! }],
      },
    });

    const resourceCandidate = report.blocked.find((candidate) => candidate.id === 'resource-1');

    expect(resourceCandidate?.readiness).toBe('BLOCKED_NO_EVIDENCE');
    expect(resourceCandidate?.reasons.join(' ')).toContain('cloudResourceId');
  });

  it('blocks a resource from generation when deterministic rules report blockers', () => {
    const report = buildRecommendationReadinessReport({
      snapshot: buildSnapshot(),
      technicalEvidenceSnapshot: buildEvidenceSnapshot({
        readiness: 'VALIDATION_ONLY',
        recommendedActionType: 'PERFORMANCE_CAPACITY_REVIEW',
        ruleMatches: ['CPU_HIGH_UTILIZATION'],
        blockers: ['CPU_SATURATION_RISK'],
        maxTechnicalSavingsRate: 0,
      }),
    });

    const resourceCandidate = report.blocked.find((candidate) => candidate.id === 'resource-1');

    expect(resourceCandidate?.readiness).toBe('VALIDATION_ONLY');
    expect(report.candidates.some((candidate) => candidate.id === 'resource-1')).toBe(false);
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
    expect(promptBlock).toContain('no están autorizados para generación');
    expect(promptBlock).toContain('No inventes ahorros');
  });

  it('records lower-priority candidates as deferred instead of dropping them silently', () => {
    const base = buildSnapshot();
    const evidence = buildEvidenceSnapshot();
    const evidenceResource = evidence.resources[0]!;
    const resourceEvidence = Array.from({ length: 8 }, (_, index) => {
      const resourceId = `i-prod-${index + 1}`;
      const ruleEvaluation = { ...evidenceResource.ruleEvaluation!, externalResourceId: resourceId };
      return {
        ...evidenceResource,
        externalResourceId: resourceId,
        cloudResourceId: `cloud-resource-${index + 1}`,
        cost: { ...evidenceResource.cost!, cloudResourceId: `cloud-resource-${index + 1}` },
        ruleEvaluation,
        metrics: evidenceResource.metrics.map((metric) => ({
          ...metric,
          evidenceRef: metric.evidenceRef.replace('i-prod-1', resourceId),
        })),
      };
    });
    const report = buildRecommendationReadinessReport({
      snapshot: {
        ...base,
        topResources: Array.from({ length: 8 }, (_, index) => ({
          ...base.topResources[0]!,
          resourceId: `i-prod-${index + 1}`,
          cloudResourceId: `cloud-resource-${index + 1}`,
          resourceName: `worker-${index + 1}`,
          totalCost: 500 - index,
        })),
        services: Array.from({ length: 8 }, (_, index) => ({
          serviceName: `Servicio ${index + 1}`,
          provider: 'AWS',
          totalCost: 500 - index,
          metricCount: 10,
        })),
      },
      technicalEvidenceSnapshot: {
        ...evidence,
        resources: resourceEvidence,
        deterministicRules: resourceEvidence.map((resource) => resource.ruleEvaluation!),
      },
    });

    expect(report.candidates).toHaveLength(6);
    expect(report.deferred).toHaveLength(2);
    expect(report.deferred[0]?.reasons.join(' ')).toContain('Aplazado');
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

function buildEvidenceSnapshot(
  overrides: Partial<TechnicalResourceRuleEvaluation> = {},
): RecommendationEvidenceSnapshot {
  const rule: TechnicalResourceRuleEvaluation = {
    externalResourceId: 'i-prod-1',
    provider: 'AWS',
    readiness: 'GENERATABLE',
    evidenceStrength: 'HIGH',
    recommendedActionType: 'RIGHTSIZING',
    ruleMatches: ['CPU_STRONG_UNDERUTILIZATION', 'MEMORY_LOW_UTILIZATION'],
    blockers: [],
    sourceFacts: ['CPU cpu_utilization: avg=8, p95=25, p99=35, muestras=96, cobertura=14 dias.'],
    technicalEvidenceRefs: ['resource_metric_samples:i-prod-1:CPUUtilization:2026-06'],
    metricSummary: [],
    maxTechnicalSavingsRate: 0.25,
    ...overrides,
  };

  return {
    version: '1',
    hash: 'test-hash',
    tenantId: 'tenant-1',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-06-30T00:00:00.000Z',
    generatedAt: '2026-06-30T00:00:00.000Z',
    availability: 'COST_USAGE_AND_TECHNICAL_AVAILABLE',
    resources: [{
      externalResourceId: 'i-prod-1',
      cloudResourceId: 'cloud-resource-1',
      provider: 'AWS',
      linkQuality: 'COST_AND_TECHNICAL',
      cost: { cloudResourceId: 'cloud-resource-1', totalCost: 300, currency: 'USD', focusMetricCount: 80 },
      usage: [],
      metrics: [{
        metricName: 'CPUUtilization',
        metricUnit: 'Percent',
        sampleCount: 96,
        coverageDays: 14,
        min: 1,
        max: 35,
        avg: 8,
        p50: 8,
        p95: 25,
        p99: 35,
        latest: 8,
        firstSampledAt: '2026-06-16T00:00:00.000Z',
        latestSampledAt: '2026-06-29T00:00:00.000Z',
        evidenceRef: 'resource_metric_samples:i-prod-1:CPUUtilization:2026-06',
      }],
      ruleEvaluation: rule,
    }],
    deterministicRules: [rule],
  };
}

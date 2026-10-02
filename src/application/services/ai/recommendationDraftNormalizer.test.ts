import { describe, expect, test } from 'vitest';

import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type { RecommendationReadinessReport } from './RecommendationReadinessGate.js';
import { dropNonActionableFinancialDrafts, normalizeRecommendationDrafts } from './recommendationDraftNormalizer.js';

describe('normalizeRecommendationDrafts', () => {
  test('converts technical capacity language into a manual review before the auditor', () => {
    const result = normalizeRecommendationDrafts(
      [{
        cloudAccountId: 'account-1',
        type: 'RIGHTSIZING',
        severity: 'HIGH',
        title: 'Reducir capacidad de la instancia',
        description: 'Aplicar rightsizing para reducir el costo.',
        estimatedMonthlySavings: 12,
        currency: 'USD',
        evidence: { candidateId: 'resource-1', evidenceLevel: 'COST_USAGE_AND_TECHNICAL' },
      }],
      buildReadiness(),
      buildEvidence(),
    );

    const draft = result[0]!;
    expect(draft.type).toBe('PERFORMANCE_CAPACITY_REVIEW');
    expect(draft.title).toBe('Revisar capacidad y rendimiento de worker-1');
    expect(draft.description.toLowerCase()).not.toContain('rightsizing');
    expect(draft.description.toLowerCase()).not.toContain('reducir el costo');
    expect(draft.estimatedMonthlySavings).toBeUndefined();
    expect((draft.evidence as Record<string, unknown>)['potentialMonthlySavings']).toBeUndefined();
    expect((draft.evidence as Record<string, unknown>)['savingsStatus']).toBe('UNVERIFIED');
    expect((draft.evidence as Record<string, unknown>)['operationalAuthorization']).toBe('NONE');
  });

  test('marks service cost reviews as financial-only instead of requiring technical evidence', () => {
    const result = normalizeRecommendationDrafts(
      [{
        cloudAccountId: 'account-1',
        type: 'SERVICE_COST_REVIEW',
        severity: 'LOW',
        title: 'Revisar costo del servicio',
        description: 'Revisar el costo observado.',
        estimatedMonthlySavings: 10,
        currency: 'USD',
        evidence: { candidateId: 'service-1', evidenceLevel: 'COST_ONLY' },
      }],
      {
        summary: 'fixture',
        blocked: [],
        deferred: [],
        candidates: [{
          id: 'service-1',
          readiness: 'GENERATABLE',
          cloudAccountId: 'account-1',
          provider: 'OCI',
          serviceName: 'Object Storage',
          opportunityType: 'SERVICE_COST_REVIEW',
          evidenceLevelAllowed: 'COST_ONLY',
          requiresTechnicalValidation: false,
          observedCost: 100,
          savingsCalculation: {
            provenance: 'SERVER_DETERMINISTIC', version: 'priced-alternative/v1', status: 'CALCULATED',
            formula: 'BASELINE_MINUS_ALTERNATIVE_MONTHLY', baselineMonthlyCost: 120,
            alternativeMonthlyCost: 110, amount: 10, currency: 'USD', priceEvidenceRef: 'price:fixture:sku',
          },
          reviewScope: 'FINANCIAL',
          maxEstimatedMonthlySavings: 20,
          currency: 'USD',
          sourceFacts: ['Servicio Object Storage costo 100 USD.'],
          costEvidenceRefs: ['cost_metrics:aggregate:2026-08-01:2026-08-12:service:OCI:Object Storage'],
          technicalEvidenceRefs: [],
          reasons: ['Costo agregado disponible.'],
          forbiddenClaims: ['No afirmes métricas técnicas.'],
        }],
      },
    );

    expect(result[0]?.evidence).toMatchObject({
      financialReviewOnly: true,
      reviewScope: 'FINANCIAL',
      observedCost: 100,
      potentialMonthlySavings: 10,
      savingsStatus: 'POTENTIAL_NOT_VERIFIED',
      requiresManualValidation: true,
      operationalAuthorization: 'NONE',
      requiresTechnicalValidation: false,
    });
    expect(result[0]?.estimatedMonthlySavings).toBeUndefined();
  });

  test('ignores a model-provided amount and uses only a reconciled server calculation', () => {
    const calculation = {
      provenance: 'SERVER_DETERMINISTIC' as const,
      version: 'priced-alternative/v1' as const,
      status: 'CALCULATED' as const,
      formula: 'BASELINE_MINUS_ALTERNATIVE_MONTHLY' as const,
      baselineMonthlyCost: 100,
      alternativeMonthlyCost: 88,
      amount: 12,
      currency: 'USD',
      priceEvidenceRef: 'price:fixture:shape-b',
    };
    const report: RecommendationReadinessReport = {
      summary: 'fixture', blocked: [], deferred: [], candidates: [{
        id: 'service-priced', readiness: 'GENERATABLE', cloudAccountId: 'account-1', provider: 'OCI',
        serviceName: 'Compute', opportunityType: 'COST_OPTIMIZATION', evidenceLevelAllowed: 'COST_AND_USAGE',
        requiresTechnicalValidation: false, observedCost: 100, maxEstimatedMonthlySavings: 12,
        savingsCalculation: calculation, currency: 'USD', sourceFacts: ['Precio alternativo verificado.'],
        costEvidenceRefs: ['cost:fixture'], technicalEvidenceRefs: [], reasons: [], forbiddenClaims: [],
      }],
    };
    const normalized = normalizeRecommendationDrafts([{
      cloudAccountId: 'account-1', type: 'COST_OPTIMIZATION', severity: 'LOW', title: 'Review',
      description: 'Potential saving 99.', estimatedMonthlySavings: 99, currency: 'USD',
      evidence: { candidateId: 'service-priced', savingsCalculation: { provenance: 'MODEL', amount: 99 }, potentialMonthlySavings: 99 },
    }], report, undefined);

    expect(normalized[0]?.estimatedMonthlySavings).toBe(12);
    expect(normalized[0]?.evidence).toMatchObject({ savingsCalculation: calculation, maxEstimatedMonthlySavings: 12 });
    expect(normalized[0]?.evidence).not.toHaveProperty('potentialMonthlySavings');
  });

  test('drops unquantified service financial reviews when their deterministic savings cap is zero', () => {
    const readiness = {
      summary: 'fixture', blocked: [], deferred: [], candidates: [{
        id: 'service-1', readiness: 'GENERATABLE', cloudAccountId: 'account-1', provider: 'OCI',
        serviceName: 'Object Storage', opportunityType: 'SERVICE_COST_REVIEW', evidenceLevelAllowed: 'COST_ONLY',
        requiresTechnicalValidation: false, observedCost: 100, reviewScope: 'FINANCIAL', maxEstimatedMonthlySavings: 0,
        currency: 'USD', sourceFacts: [], costEvidenceRefs: [], technicalEvidenceRefs: [], reasons: [], forbiddenClaims: [],
      }],
    } as unknown as RecommendationReadinessReport;
    const normalized = normalizeRecommendationDrafts([{
      cloudAccountId: 'account-1', type: 'SERVICE_COST_REVIEW', severity: 'LOW', title: 'Revisar costo',
      description: 'Revisar el costo del servicio.', estimatedMonthlySavings: 0, currency: 'USD',
      evidence: { candidateId: 'service-1' },
    }], readiness, undefined, undefined, 30);

    expect(dropNonActionableFinancialDrafts(normalized, readiness)).toHaveLength(0);
  });

  test('keeps a resource without technical evidence as an explicit validation-only opportunity', () => {
    const result = normalizeRecommendationDrafts(
      [{
        cloudAccountId: 'account-1',
        type: 'RIGHTSIZING',
        severity: 'MEDIUM',
        title: 'Reducir el tamaño del recurso',
        description: 'Reducir capacidad para ahorrar.',
        estimatedMonthlySavings: 15,
        currency: 'USD',
        evidence: {
          candidateId: 'resource-2',
          evidenceLevel: 'COST_ONLY',
          technicalEvidenceRefs: ['invented-ref'],
        },
      }],
      {
        summary: 'fixture',
        blocked: [],
        deferred: [],
        candidates: [{
          id: 'resource-2',
          readiness: 'VALIDATION_ONLY',
          cloudAccountId: 'account-1',
          provider: 'OCI',
          serviceName: 'PostgreSQL',
          resourceId: 'ocid1.postgresql.oc1..exampleid0020',
          opportunityType: 'PERFORMANCE_CAPACITY_REVIEW',
          evidenceLevelAllowed: 'COST_ONLY',
          requiresTechnicalValidation: true,
          reviewScope: 'TECHNICAL',
          maxEstimatedMonthlySavings: 20,
          currency: 'USD',
          sourceFacts: ['Costo del recurso observado en facturación.'],
          costEvidenceRefs: ['cost_metrics:resource:fixture'],
          technicalEvidenceRefs: [],
          reasons: ['No hay cobertura técnica suficiente.'],
          forbiddenClaims: ['No afirmes utilización técnica.'],
        }],
      },
      {
        version: '1',
        hash: 'fixture-hash',
        tenantId: 'tenant-1',
        periodStart: '2026-08-01T00:00:00.000Z',
        periodEnd: '2026-08-12T00:00:00.000Z',
        generatedAt: '2026-08-12T00:00:00.000Z',
        availability: 'COST_ONLY_AVAILABLE',
        deterministicRules: [],
        resources: [],
      },
    );

    const draft = result[0]!;
    const evidence = draft.evidence as Record<string, unknown>;
    expect(draft.type).toBe('TECHNICAL_VALIDATION_REQUIRED');
    expect(draft.title).toBe('Validar señales técnicas de PostgreSQL (ocid1.po…id0020)');
    expect(draft.description).toContain('No hay evidencia técnica enlazada y reciente suficiente');
    expect(draft.description.toLowerCase()).not.toContain('reducir capacidad');
    expect(draft.estimatedMonthlySavings).toBeUndefined();
    expect(draft.cloudResourceId).toBeUndefined();
    expect(draft.resourceLinkReason).toBe('INVENTORY_RESOURCE_NOT_FOUND');
    expect(evidence).toMatchObject({
      candidateId: 'resource-2',
      evidenceLevel: 'COST_ONLY',
      technicalReviewOnly: true,
      operationalAuthorization: 'NONE',
      requiresManualValidation: true,
      requiresTechnicalValidation: true,
    });
    expect(evidence['technicalEvidenceRefs']).toBeUndefined();
  });

  test('overwrites monthly cost evidence and removes an invalid technical scope from usage candidates', () => {
    const result = normalizeRecommendationDrafts(
      [{
        cloudAccountId: 'account-2',
        type: 'USAGE_OPTIMIZATION',
        severity: 'MEDIUM',
        title: 'Optimizar consumo',
        description: 'Reducir el consumo facturado.',
        estimatedMonthlySavings: 5,
        currency: 'USD',
        evidence: {
          candidateId: 'usage-1',
          evidenceLevel: 'COST_AND_USAGE',
          reviewScope: 'TECHNICAL',
          requiresTechnicalValidation: true,
          normalizedMonthlyCost: 999,
        },
      }],
      {
        summary: 'fixture',
        blocked: [],
        deferred: [],
        candidates: [{
          id: 'usage-1',
          readiness: 'GENERATABLE',
          cloudAccountId: 'account-1',
          provider: 'OCI',
          serviceName: 'Object Storage',
          opportunityType: 'USAGE_OPTIMIZATION',
          evidenceLevelAllowed: 'COST_AND_USAGE',
          requiresTechnicalValidation: false,
          observedCost: 100,
          maxEstimatedMonthlySavings: 12,
          currency: 'USD',
          sourceFacts: ['Costo de consumo observado: 100 USD.'],
          costEvidenceRefs: ['cost_metrics:usage:fixture'],
          technicalEvidenceRefs: [],
          reasons: [],
          forbiddenClaims: [],
        }],
      },
      undefined,
      undefined,
      30,
    );

    const evidence = result[0]?.evidence as Record<string, unknown>;
    expect(result[0]?.cloudAccountId).toBe('account-1');
    expect(evidence['reviewScope']).toBeUndefined();
    expect(evidence['financialReviewOnly']).toBeUndefined();
    expect(evidence['requiresTechnicalValidation']).toBe(false);
    expect(evidence['normalizedMonthlyCost']).toBe(100);
  });

  test('preserves the canonical inventory link when technical evidence is unavailable', () => {
    const result = normalizeRecommendationDrafts(
      [{
        cloudAccountId: 'account-1',
        type: 'TECHNICAL_VALIDATION_REQUIRED',
        severity: 'MEDIUM',
        title: 'Validar recurso',
        description: 'Validar el recurso antes de actuar.',
        currency: 'USD',
        evidence: { candidateId: 'resource-3', evidenceLevel: 'COST_ONLY' },
      }],
      {
        summary: 'fixture',
        blocked: [],
        deferred: [],
        candidates: [{
          id: 'resource-3',
          readiness: 'VALIDATION_ONLY',
          cloudAccountId: 'account-1',
          provider: 'OCI',
          serviceName: 'Compute',
          resourceId: 'instance-3',
          cloudResourceId: 'inventory-3',
          opportunityType: 'TECHNICAL_VALIDATION_REQUIRED',
          evidenceLevelAllowed: 'COST_ONLY',
          requiresTechnicalValidation: true,
          observedCost: 100,
          maxEstimatedMonthlySavings: 18,
          currency: 'USD',
          sourceFacts: ['Costo observado.'],
          costEvidenceRefs: ['cost-ref'],
          technicalEvidenceRefs: [],
          reasons: [],
          forbiddenClaims: [],
        }],
      },
      { version: '1', hash: 'hash', tenantId: 'tenant-1', periodStart: '2026-08-01', periodEnd: '2026-08-12', generatedAt: '2026-08-12', availability: 'COST_ONLY_AVAILABLE', deterministicRules: [], resources: [] },
      undefined,
      30,
    );

    expect(result[0]?.cloudResourceId).toBe('inventory-3');
    expect((result[0]?.evidence as Record<string, unknown>)['cloudResourceId']).toBe('inventory-3');
  });
});

function buildReadiness(): RecommendationReadinessReport {
  return {
    summary: 'fixture',
    blocked: [],
    deferred: [],
    candidates: [{
      id: 'resource-1',
      readiness: 'GENERATABLE',
      cloudAccountId: 'account-1',
      provider: 'OCI',
      serviceName: 'Compute',
      resourceId: 'i-resource-1',
      resourceName: 'worker-1',
      cloudResourceId: 'cloud-resource-1',
      opportunityType: 'RIGHTSIZING',
      evidenceLevelAllowed: 'COST_USAGE_AND_TECHNICAL',
      requiresTechnicalValidation: true,
      maxEstimatedMonthlySavings: 20,
      currency: 'USD',
      sourceFacts: ['CPU con uso bajo sostenido.'],
      technicalEvidenceRefs: ['metric-ref'],
      evidenceStrength: 'HIGH',
      ruleMatches: ['CPU_MODERATE_UNDERUTILIZATION'],
      blockers: [],
      reasons: [],
      forbiddenClaims: [],
    }],
  };
}

function buildEvidence(): RecommendationEvidenceSnapshot {
  return {
    version: '1',
    hash: 'fixture-hash',
    tenantId: 'tenant-1',
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-08-12T00:00:00.000Z',
    generatedAt: '2026-08-12T00:00:00.000Z',
    availability: 'COST_USAGE_AND_TECHNICAL_AVAILABLE',
    deterministicRules: [],
    resources: [{
      externalResourceId: 'i-resource-1',
      cloudResourceId: 'cloud-resource-1',
      provider: 'OCI',
      resourceType: 'COMPUTE_INSTANCE',
      serviceName: 'Compute',
      linkQuality: 'COST_AND_TECHNICAL',
      usage: [],
      metrics: [{
        metricName: 'CPUUtilization',
        metricUnit: '%',
        sampleCount: 672,
        coverageDays: 14,
        min: 8,
        max: 19,
        avg: 13,
        p50: 13,
        p95: 19,
        p99: 19,
        latest: 13,
        highUtilizationSampleCount: 0,
        highUtilizationRatio: 0,
        firstSampledAt: '2026-08-01T00:00:00.000Z',
        latestSampledAt: '2026-08-12T00:00:00.000Z',
        evidenceRef: 'metric-ref',
      }],
      ruleEvaluation: {
        externalResourceId: 'i-resource-1',
        cloudResourceId: 'cloud-resource-1',
        provider: 'OCI',
        resourceType: 'COMPUTE_INSTANCE',
        serviceName: 'Compute',
        readiness: 'GENERATABLE',
        evidenceStrength: 'HIGH',
        recommendedActionType: 'RIGHTSIZING',
        ruleMatches: ['CPU_MODERATE_UNDERUTILIZATION'],
        blockers: [],
        sourceFacts: ['CPU con uso bajo sostenido.'],
        technicalEvidenceRefs: ['metric-ref'],
        metricSummary: [],
        maxTechnicalSavingsRate: 0.15,
      },
    }],
  };
}

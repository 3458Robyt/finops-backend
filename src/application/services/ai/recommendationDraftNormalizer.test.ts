import { describe, expect, test } from 'vitest';

import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';
import type { RecommendationReadinessReport } from './RecommendationReadinessGate.js';
import { normalizeRecommendationDrafts } from './recommendationDraftNormalizer.js';

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
    expect(draft.title).toBe('Revisar capacidad y rendimiento de i-resource-1');
    expect(draft.description.toLowerCase()).not.toContain('rightsizing');
    expect(draft.description.toLowerCase()).not.toContain('reducir el costo');
    expect(draft.estimatedMonthlySavings).toBeUndefined();
    expect((draft.evidence as Record<string, unknown>)['potentialMonthlySavings']).toBe(12);
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
      requiresManualValidation: true,
      operationalAuthorization: 'NONE',
      requiresTechnicalValidation: false,
    });
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
          resourceId: 'ocid1.postgresql.oc1.example',
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
    expect(draft.title).toBe('Validar señales técnicas de ocid1.postgresql.oc1.example');
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

import { describe, expect, test } from 'vitest';
import { evaluateGlobalLearningCandidate, evaluateGlobalLearningCanary } from './learningPromotionEvaluator.js';
import type { GlobalLearningCanaryEvidence } from '../../../domain/models/AgentLearning.js';
import type { MemoryCandidate } from './learningMemoryContent.js';

const candidate: MemoryCandidate = {
  memoryType: 'APPROVAL_PATTERN',
  content: 'Patrón global FinOps para RIGHTSIZING: priorizar acciones reversibles.',
  fingerprint: 'APPROVED:APPROVED_HIGH_CONFIDENCE:RIGHTSIZING',
  metadata: {
    recommendationType: 'RIGHTSIZING',
    reasonCode: 'APPROVED_HIGH_CONFIDENCE',
    decision: 'APPROVED',
  },
};

describe('learning promotion evaluator', () => {
  test('passes the offline safety gate but remains shadow without live quality evidence', () => {
    const result = evaluateGlobalLearningCandidate({
      candidate,
      auditScore: 95,
      patternCount: { eventCount: 5, tenantCount: 2 },
    });

    expect(result.passed).toBe(true);
    expect(result.readyForPromotion).toBe(false);
    expect(result.goldenScenarioPassed).toBe(result.goldenScenarioCount);
    expect(result.promotionBlockers).toContain('Aún no existe evidencia de canary live que demuestre mejora sin degradación.');
  });

  test('rejects candidates below the audit or sample thresholds', () => {
    const result = evaluateGlobalLearningCandidate({
      candidate,
      auditScore: 89,
      patternCount: { eventCount: 4, tenantCount: 1 },
    });

    expect(result.passed).toBe(false);
    expect(result.blockingReasons).toEqual(expect.arrayContaining([
      'La puntuación del auditor es inferior a 90.',
      'La muestra no alcanza cinco eventos similares.',
      'La muestra no abarca dos tenants distintos.',
    ]));
  });

  test('rejects tenant-specific identifiers from a global candidate', () => {
    const result = evaluateGlobalLearningCandidate({
      candidate: { ...candidate, metadata: { tenantId: 'tenant-secret' } },
      auditScore: 95,
      patternCount: { eventCount: 5, tenantCount: 2 },
    });

    expect(result.passed).toBe(false);
    expect(result.blockingReasons).toContain('El candidato contiene datos identificables o referencias de alcance tenant.');
  });

  test('requires strict live improvement before promoting a global candidate', () => {
    const evidence = canaryEvidence({
      baseline: { qualityScore: 92, approvedRecommendationCount: 1 },
      candidate: { qualityScore: 95, approvedRecommendationCount: 1 },
    });

    expect(evaluateGlobalLearningCanary(evidence)).toMatchObject({
      passed: true,
      qualityImproved: true,
      noDegradation: true,
    });
  });

  test('blocks equal-quality or degraded candidates and invalid outputs', () => {
    const evidence = canaryEvidence({
      baseline: { qualityScore: 95, approvedRecommendationCount: 2 },
      candidate: { qualityScore: 95, approvedRecommendationCount: 1, invalidOutputCount: 1 },
    });

    const result = evaluateGlobalLearningCanary(evidence);
    expect(result.passed).toBe(false);
    expect(result.noDegradation).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      'El brazo candidate contiene salidas inválidas.',
      'El candidato degrada al menos una métrica de calidad o seguridad.',
      'El candidato no demuestra una mejora estricta frente a la línea base.',
    ]));
  });
});

function canaryEvidence(input: {
  readonly baseline: Partial<GlobalLearningCanaryEvidence['baseline']>;
  readonly candidate: Partial<GlobalLearningCanaryEvidence['candidate']>;
}): GlobalLearningCanaryEvidence {
  const arm = (overrides: Partial<GlobalLearningCanaryEvidence['baseline']>) => ({
    recommendationCount: 1,
    approvedRecommendationCount: 1,
    invalidOutputCount: 0,
    nonNegativeSavings: true,
    qualityScore: 90,
    tokenEstimate: 100,
    latencyMs: 500,
    ...overrides,
  });
  return {
    mode: 'LIVE_COMPARATIVE_CANARY',
    runId: 'test-canary',
    candidateMemoryId: 'memory-1',
    baseline: arm(input.baseline),
    candidate: arm(input.candidate),
    generatedAt: '2026-08-12T00:00:00.000Z',
  };
}

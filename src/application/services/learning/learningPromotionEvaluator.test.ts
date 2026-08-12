import { describe, expect, test } from 'vitest';
import { evaluateGlobalLearningCandidate } from './learningPromotionEvaluator.js';
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
});

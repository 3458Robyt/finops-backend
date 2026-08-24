import { describe, expect, it } from 'vitest';
import { GlobalLearningPromotionService } from './GlobalLearningPromotionService.js';
import type { IAgentLearningRepository } from '../../../domain/interfaces/IAgentLearningRepository.js';
import type { AuthContext } from '../../../domain/models/AuthContext.js';
import type { GlobalLearningCanaryEvidence } from '../../../domain/models/AgentLearning.js';

const master: AuthContext = {
  userId: 'master-1',
  tenantId: 'tenant-1',
  email: 'master@example.test',
  role: 'MASTER_ADMIN',
  jwtId: 'jwt-1',
};

const evidence: GlobalLearningCanaryEvidence = {
  mode: 'LIVE_COMPARATIVE_CANARY',
  runId: 'canary-1',
  candidateMemoryId: 'memory-1',
  baseline: {
    recommendationCount: 1,
    approvedRecommendationCount: 1,
    invalidOutputCount: 0,
    nonNegativeSavings: true,
    qualityScore: 90,
    tokenEstimate: 100,
    latencyMs: 500,
  },
  candidate: {
    recommendationCount: 1,
    approvedRecommendationCount: 1,
    invalidOutputCount: 0,
    nonNegativeSavings: true,
    qualityScore: 95,
    tokenEstimate: 105,
    latencyMs: 520,
  },
  generatedAt: '2026-08-12T00:00:00.000Z',
};

describe('GlobalLearningPromotionService', () => {
  it('does not allow non-master actors to promote cross-tenant learning', async () => {
    const repository = createRepository();
    const service = new GlobalLearningPromotionService(repository);

    await expect(service.promote({
      actor: { ...master, role: 'ADMIN' },
      sourceLearningEventId: 'event-1',
      evidence,
    })).rejects.toThrow('Solo el administrador maestro');
    expect(repository.promoted).toBe(false);
  });

  it('requires a strict live improvement before delegating promotion', async () => {
    const repository = createRepository();
    const service = new GlobalLearningPromotionService(repository);
    const equalEvidence = {
      ...evidence,
      candidate: { ...evidence.candidate, qualityScore: evidence.baseline.qualityScore },
    };

    await expect(service.promote({
      actor: master,
      sourceLearningEventId: 'event-1',
      evidence: equalEvidence,
    })).rejects.toThrow('no supera el canary');
    expect(repository.promoted).toBe(false);
  });

  it('delegates an approved promotion to the audited repository port', async () => {
    const repository = createRepository();
    const service = new GlobalLearningPromotionService(repository);

    await expect(service.promote({
      actor: master,
      sourceLearningEventId: 'event-1',
      evidence,
    })).resolves.toMatchObject({ id: 'memory-1', active: true });
    expect(repository.promoted).toBe(true);
  });
});

function createRepository(): IAgentLearningRepository & { promoted: boolean } {
  const repository = {
    promoted: false,
    promoteGlobalMemoryWithEvidence: async () => {
      repository.promoted = true;
      return {
        id: 'memory-1',
        scope: 'GLOBAL' as const,
        memoryType: 'APPROVAL_PATTERN' as const,
        content: 'Patrón global auditado.',
        confidence: 0.95,
        active: true,
        createdAt: new Date('2026-08-12T00:00:00.000Z'),
      };
    },
  } as unknown as IAgentLearningRepository & { promoted: boolean };
  return repository;
}

import { describe, expect, test, vi } from 'vitest';
import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import { defaultProfile } from './agentInstruction/agentInstructionValidation.js';
import { AgentInstructionService } from './AgentInstructionService.js';
import { ContextEngineService } from './ContextEngineService.js';

describe('ContextEngineService', () => {
  test('does not duplicate operation facts in the shared context and scopes chat priorities', async () => {
    const repository = {
      findActiveProfile: vi.fn().mockResolvedValue(defaultProfile()),
      listTenantRules: vi.fn().mockResolvedValue([]),
      findContextSummaries: vi.fn().mockResolvedValue([]),
    } as unknown as IAgentContextRepository;
    const service = new ContextEngineService(
      repository,
      new AgentInstructionService(repository),
    );

    const context = await service.buildContext({
      tenantId: 'tenant-1',
      operation: 'CHAT',
      queryText: 'Explica el costo total',
      snapshot: { totalCost: 999 } as never,
      recommendation: { title: 'Recomendación que no debe serializarse' } as never,
      model: 'test-model',
    });

    expect(context.contextText).not.toContain('Snapshot factual autorizado');
    expect(context.contextText).not.toContain('Recomendacion objetivo');
    expect(context.contextText).toContain('Prioridades de recomendacion: se aplican solo cuando el usuario solicita una recomendacion.');
    expect(context.systemInstructions).toContain('sin convertirla en una recomendacion');
  });

  test('keeps execution plans scoped to active profile and tenant rules, without unrelated summaries or learning', async () => {
    const findContextSummaries = vi.fn().mockResolvedValue([{
      id: 'summary-1',
      artifactType: 'COST_ANALYSIS',
      scopeKey: 'tenant',
      summary: 'Conflicting finance fact USD 169',
    }]);
    const repository = {
      findActiveProfile: vi.fn().mockResolvedValue(defaultProfile()),
      listTenantRules: vi.fn().mockResolvedValue([]),
      findContextSummaries,
    } as unknown as IAgentContextRepository;
    const getRecommendationLearningContext = vi.fn().mockResolvedValue({
      memoryIds: ['memory-1'],
      caseIds: ['case-1'],
      summary: 'Conflicting learned amount USD 157.50',
    });
    const service = new ContextEngineService(
      repository,
      new AgentInstructionService(repository),
      { getRecommendationLearningContext } as never,
    );

    const context = await service.buildContext({
      tenantId: 'tenant-1',
      operation: 'EXECUTION_PLAN',
      queryText: 'Plan recommendation rec-1',
      snapshot: {} as never,
      recommendation: {} as never,
      model: 'test-model',
    });

    expect(findContextSummaries).not.toHaveBeenCalled();
    expect(getRecommendationLearningContext).not.toHaveBeenCalled();
    expect(context.contextText).not.toContain('USD 169');
    expect(context.contextText).not.toContain('USD 157.50');
    expect(context.artifactIds).toEqual([]);
    expect(context.memoryIds).toEqual([]);
  });
});

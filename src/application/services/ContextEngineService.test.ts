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
});

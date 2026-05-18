import type { IAgentContextRepository } from '../../domain/interfaces/IAgentContextRepository.js';
import type { AiContextOperation } from '../../domain/models/AgentContext.js';

export class AiObservabilityService {
  constructor(private readonly repository: IAgentContextRepository) {}

  public async recordTrace(input: {
    readonly tenantId: string;
    readonly userId?: string;
    readonly operation: AiContextOperation;
    readonly model: string;
    readonly status: 'SUCCESS' | 'ERROR';
    readonly profileVersion?: number;
    readonly promptTokenEstimate: number;
    readonly responseText?: string;
    readonly latencyMs?: number;
    readonly artifactIds?: readonly string[];
    readonly memoryIds?: readonly string[];
    readonly knowledgeNodeIds?: readonly string[];
    readonly tenantRuleIds?: readonly string[];
    readonly conflicts?: readonly string[];
    readonly errorMessage?: string;
  }): Promise<void> {
    await this.repository.createAiContextTrace({
      tenantId: input.tenantId,
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      operation: input.operation,
      model: input.model,
      status: input.status,
      ...(input.profileVersion !== undefined ? { profileVersion: input.profileVersion } : {}),
      promptTokenEstimate: input.promptTokenEstimate,
      ...(input.responseText !== undefined ? { responseTokenEstimate: this.estimateTokens(input.responseText) } : {}),
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.artifactIds !== undefined ? { artifactIds: input.artifactIds } : {}),
      ...(input.memoryIds !== undefined ? { memoryIds: input.memoryIds } : {}),
      ...(input.knowledgeNodeIds !== undefined ? { knowledgeNodeIds: input.knowledgeNodeIds } : {}),
      ...(input.tenantRuleIds !== undefined ? { tenantRuleIds: input.tenantRuleIds } : {}),
      ...(input.conflicts !== undefined ? { conflicts: input.conflicts } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    });
  }

  private estimateTokens(value: string): number {
    return Math.ceil(value.length / 4);
  }
}

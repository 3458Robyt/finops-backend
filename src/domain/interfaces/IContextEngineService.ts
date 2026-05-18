import type { CostAnalyticsSnapshot } from './ICostAnalyticsRepository.js';
import type { AiContextOperation } from '../models/AgentContext.js';
import type { FinOpsRecommendation } from '../models/FinOpsRecommendation.js';

export interface BuildAiContextInput {
  readonly tenantId: string;
  readonly userId?: string;
  readonly operation: AiContextOperation;
  readonly queryText: string;
  readonly snapshot: CostAnalyticsSnapshot;
  readonly recommendation?: FinOpsRecommendation;
  readonly model: string;
}

export interface BuiltAiContext {
  readonly systemInstructions: string;
  readonly contextText: string;
  readonly artifactIds: readonly string[];
  readonly memoryIds: readonly string[];
  readonly caseIds: readonly string[];
  readonly knowledgeNodeIds: readonly string[];
  readonly tenantRuleIds: readonly string[];
  readonly conflicts: readonly string[];
  readonly profileVersion?: number;
  readonly promptTokenEstimate: number;
}

export interface IContextEngineService {
  buildContext(input: BuildAiContextInput): Promise<BuiltAiContext>;
}

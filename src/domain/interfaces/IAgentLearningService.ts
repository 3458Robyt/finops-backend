import type {
  AgentLearningStatus,
  RecommendationFeedbackReason,
} from '../models/AgentLearning.js';

export interface ProcessRecommendationDecisionInput {
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly decisionId: string;
  readonly userId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly reasonCode: RecommendationFeedbackReason;
  readonly reason?: string;
}

export interface RecommendationLearningResult {
  readonly status: AgentLearningStatus;
  readonly eventId?: string;
  readonly error?: string;
}

export interface AgentLearningContextQuery {
  readonly tenantId: string;
  readonly queryText: string;
  readonly limit?: number;
}

export interface AgentLearningContext {
  readonly memoryIds: readonly string[];
  readonly caseIds: readonly string[];
  readonly summary: string;
}

export interface AgentLearningSummary {
  readonly memories: readonly {
    readonly id: string;
    readonly scope: string;
    readonly memoryType: string;
    readonly content: string;
    readonly confidence: number;
    readonly createdAt: Date;
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly recommendationId: string;
    readonly decisionId: string;
    readonly status: AgentLearningStatus;
    readonly createdAt: Date;
  }[];
}

export interface IAgentLearningContextProvider {
  getRecommendationLearningContext(query: AgentLearningContextQuery): Promise<AgentLearningContext>;
}

export interface IAgentLearningService extends IAgentLearningContextProvider {
  queueRecommendationDecision(input: ProcessRecommendationDecisionInput): Promise<RecommendationLearningResult>;
  processQueuedRecommendationDecision(eventId: string): Promise<RecommendationLearningResult>;
  processRecommendationDecision(input: ProcessRecommendationDecisionInput): Promise<RecommendationLearningResult>;
  getLearningSummary(tenantId: string): Promise<AgentLearningSummary>;
}

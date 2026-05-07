import type {
  AgentLearningEvent,
  AgentLearningStatus,
  AgentMemory,
  AgentMemoryScope,
  AgentMemoryType,
  RecommendationFeedbackReason,
} from '../models/AgentLearning.js';
import type {
  AgentLearningContext,
  AgentLearningSummary,
} from './IAgentLearningService.js';

export interface CreateAgentLearningEventInput {
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly decisionId: string;
  readonly userId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly reasonCode: RecommendationFeedbackReason;
  readonly reason?: string;
  readonly recommendationType: string;
  readonly cloudAccountId: string;
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  readonly evidenceSummary: string;
}

export interface CompleteAgentLearningEventInput {
  readonly eventId: string;
  readonly status: AgentLearningStatus;
  readonly auditVerdict?: string;
  readonly auditScore?: number;
  readonly auditReport?: unknown;
  readonly errorMessage?: string;
}

export interface CreateAgentMemoryInput {
  readonly tenantId?: string;
  readonly scope: AgentMemoryScope;
  readonly memoryType: AgentMemoryType;
  readonly content: string;
  readonly confidence: number;
  readonly sourceLearningEventId: string;
  readonly metadata: unknown;
  readonly auditVerdict: string;
  readonly auditScore: number;
  readonly auditReport: unknown;
  readonly fingerprint: string;
}

export interface QueuedAgentLearningEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly decisionId: string;
  readonly userId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly reasonCode: RecommendationFeedbackReason;
  readonly reason?: string;
}

export interface SimilarLearningPatternCount {
  readonly eventCount: number;
  readonly tenantCount: number;
}

export interface IAgentLearningRepository {
  createEvent(input: CreateAgentLearningEventInput): Promise<AgentLearningEvent>;
  findQueuedEventById(eventId: string): Promise<QueuedAgentLearningEvent | null>;
  completeEvent(input: CompleteAgentLearningEventInput): Promise<AgentLearningEvent>;
  createMemory(input: CreateAgentMemoryInput): Promise<AgentMemory>;
  findRecommendationLearningContext(input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  }): Promise<AgentLearningContext>;
  findSummary(tenantId: string): Promise<AgentLearningSummary>;
  countSimilarApprovedEvents(input: {
    readonly reasonCode: RecommendationFeedbackReason;
    readonly recommendationType: string;
    readonly decision: 'APPROVED' | 'REJECTED';
  }): Promise<SimilarLearningPatternCount>;
  hasActiveGlobalMemory(fingerprint: string): Promise<boolean>;
}

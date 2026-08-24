import type {
  CompleteAgentLearningEventInput,
  CreateAgentLearningEventInput,
  CreateAgentMemoryInput,
  IAgentLearningRepository,
  QueuedAgentLearningEvent,
  RecordApprovedLearningInput,
  SimilarLearningPatternCount,
} from "../../domain/interfaces/IAgentLearningRepository.js";
import type {
  AgentLearningContext,
  AgentLearningSummary,
} from "../../domain/interfaces/IAgentLearningService.js";
import type {
  AgentLearningEvent,
  AgentMemory,
  GlobalLearningCanaryEvidence,
} from "../../domain/models/AgentLearning.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaAgentLearningEventRepository } from "./PrismaAgentLearningEventRepository.js";
import { PrismaAgentLearningMemoryRepository } from "./PrismaAgentLearningMemoryRepository.js";
import { PrismaAgentLearningQueryRepository } from "./PrismaAgentLearningQueryRepository.js";

/** Stable learning repository facade preserving the domain port. */
export class PrismaAgentLearningRepository implements IAgentLearningRepository {
  private readonly memoryRepository: PrismaAgentLearningMemoryRepository;
  private readonly eventRepository: PrismaAgentLearningEventRepository;
  private readonly queryRepository: PrismaAgentLearningQueryRepository;

  constructor(prisma: PrismaClient) {
    this.memoryRepository = new PrismaAgentLearningMemoryRepository(prisma);
    this.eventRepository = new PrismaAgentLearningEventRepository(
      prisma,
      this.memoryRepository,
    );
    this.queryRepository = new PrismaAgentLearningQueryRepository(prisma);
  }

  public createEvent(
    input: CreateAgentLearningEventInput,
  ): Promise<AgentLearningEvent> {
    return this.eventRepository.createEvent(input);
  }
  public findQueuedEventById(
    eventId: string,
  ): Promise<QueuedAgentLearningEvent | null> {
    return this.eventRepository.findQueuedEventById(eventId);
  }
  public claimNextQueuedEvent(input: {
    readonly workerId: string;
    readonly leaseExpiredBefore: Date;
  }): Promise<QueuedAgentLearningEvent | null> {
    return this.eventRepository.claimNextQueuedEvent(input);
  }
  public releaseEventForRetry(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly errorMessage: string;
    readonly nextAttemptAt: Date;
  }) {
    return this.eventRepository.releaseEventForRetry(input);
  }
  public completeEvent(
    input: CompleteAgentLearningEventInput,
  ): Promise<AgentLearningEvent> {
    return this.eventRepository.completeEvent(input);
  }
  public createMemory(input: CreateAgentMemoryInput): Promise<AgentMemory> {
    return this.memoryRepository.createMemory(input);
  }
  public deactivateMemory(input: {
    readonly tenantId: string;
    readonly memoryId: string;
    readonly allowGlobal: boolean;
    readonly actorUserId: string;
  }): Promise<AgentMemory | null> {
    return this.memoryRepository.deactivateMemory(input);
  }
  public promoteGlobalMemoryWithEvidence(input: {
    readonly sourceLearningEventId: string;
    readonly actorUserId: string;
    readonly evidence: GlobalLearningCanaryEvidence;
  }): Promise<AgentMemory | null> {
    return this.memoryRepository.promoteGlobalMemoryWithEvidence(input);
  }
  public recordApprovedLearning(
    input: RecordApprovedLearningInput,
  ): Promise<AgentLearningEvent> {
    return this.eventRepository.recordApprovedLearning(input);
  }
  public findRecommendationLearningContext(input: {
    readonly tenantId: string;
    readonly queryText: string;
    readonly limit: number;
  }): Promise<AgentLearningContext> {
    return this.queryRepository.findRecommendationLearningContext(input);
  }
  public findSummary(tenantId: string): Promise<AgentLearningSummary> {
    return this.queryRepository.findSummary(tenantId);
  }
  public countSimilarApprovedEvents(input: {
    readonly reasonCode: CreateAgentLearningEventInput["reasonCode"];
    readonly recommendationType: string;
    readonly decision: "APPROVED" | "REJECTED";
  }): Promise<SimilarLearningPatternCount> {
    return this.queryRepository.countSimilarApprovedEvents(input);
  }
  public hasActiveGlobalMemory(fingerprint: string): Promise<boolean> {
    return this.queryRepository.hasActiveGlobalMemory(fingerprint);
  }
  public hasGlobalMemoryCandidate(fingerprint: string): Promise<boolean> {
    return this.queryRepository.hasGlobalMemoryCandidate(fingerprint);
  }
}

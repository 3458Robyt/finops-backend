import { describe, expect, test } from 'vitest';
import { AgentLearningService } from './AgentLearningService.js';
import type { IAiGateway, AiGatewayRequest } from '../../domain/interfaces/IAiGateway.js';
import type {
  CompleteAgentLearningEventInput,
  CreateAgentLearningEventInput,
  CreateAgentMemoryInput,
  IAgentLearningRepository,
  RecordApprovedLearningInput,
  SimilarLearningPatternCount,
} from '../../domain/interfaces/IAgentLearningRepository.js';
import type {
  CreateRecommendationDecisionInput,
  CreateRecommendationDecisionResult,
  CreateRecommendationExecutionPlanInput,
  CreateRecommendationInput,
  IRecommendationRepository,
  RecommendationQuery,
} from '../../domain/interfaces/IRecommendationRepository.js';
import type { AgentLearningEvent, AgentMemory } from '../../domain/models/AgentLearning.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import type { RecommendationExecutionPlan } from '../../domain/models/RecommendationExecutionPlan.js';

class FakeAiGateway implements IAiGateway {
  public readonly modelName = 'fake-model';
  public lastRequest: AiGatewayRequest | null = null;

  public async generateText(request: AiGatewayRequest): Promise<string> {
    this.lastRequest = request;
    return JSON.stringify({
      verdict: 'APPROVED',
      score: 91,
      checks: [{ name: 'privacidad', passed: true, notes: 'No contiene identificadores sensibles.' }],
      blockingIssues: [],
      requiredChanges: [],
    });
  }
}

class TimeoutAiGateway implements IAiGateway {
  public readonly modelName = 'fake-model';

  public async generateText(_request: AiGatewayRequest): Promise<string> {
    throw new Error('Request timed out.');
  }
}

class FakeRecommendationRepository implements IRecommendationRepository {
  public async findByTenant(_query: RecommendationQuery): Promise<FinOpsRecommendation[]> {
    return [];
  }

  public async findById(_tenantId: string, recommendationId: string): Promise<FinOpsRecommendation | null> {
    return {
      id: recommendationId,
      cloudAccountId: 'account-focus-aws-prod',
      type: 'RIGHTSIZING',
      status: 'APPROVED',
      severity: 'HIGH',
      title: 'Reducir EC2 con evidencia de utilizacion',
      description: 'Validar CPU y memoria antes de cambiar instancias.',
      evidence: { serviceName: 'Amazon Elastic Compute Cloud', metric: 'CPUUtilization' },
      estimatedMonthlySavings: 18.25,
      currency: 'USD',
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: new Date('2026-04-29T12:00:00.000Z'),
    };
  }

  public async createMany(_input: readonly CreateRecommendationInput[]): Promise<FinOpsRecommendation[]> {
    return [];
  }

  public async createExecutionPlan(
    _input: CreateRecommendationExecutionPlanInput,
  ): Promise<RecommendationExecutionPlan> {
    throw new Error('not used');
  }

  public async findExecutionPlanById(): Promise<RecommendationExecutionPlan | null> {
    return null;
  }

  public async findLatestExecutionPlanByRecommendation(): Promise<RecommendationExecutionPlan | null> {
    return null;
  }

  public async createDecision(
    _input: CreateRecommendationDecisionInput,
  ): Promise<CreateRecommendationDecisionResult> {
    throw new Error('not used');
  }
}

class FakeAgentLearningRepository implements IAgentLearningRepository {
  public eventInput: CreateAgentLearningEventInput | null = null;
  public completed: CompleteAgentLearningEventInput | null = null;
  public memoryInput: CreateAgentMemoryInput | null = null;
  public recordedApproved: RecordApprovedLearningInput | null = null;
  public retryInput: { readonly eventId: string; readonly workerId: string; readonly errorMessage: string } | null = null;
  public deactivatedMemoryId: string | null = null;
  public similarPatternCount: SimilarLearningPatternCount = { eventCount: 1, tenantCount: 1 };
  public promotedGlobalEventId: string | null = null;

  public async createEvent(input: CreateAgentLearningEventInput): Promise<AgentLearningEvent> {
    this.eventInput = input;
    return {
      id: 'event-1',
      tenantId: input.tenantId,
      recommendationId: input.recommendationId,
      decisionId: input.decisionId,
      status: 'PENDING',
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
    };
  }

  public async findQueuedEventById(eventId: string) {
    if (this.eventInput === null) {
      return null;
    }

    return {
      id: eventId,
      tenantId: this.eventInput.tenantId,
      recommendationId: this.eventInput.recommendationId,
      decisionId: this.eventInput.decisionId,
      userId: this.eventInput.userId,
      decision: this.eventInput.decision,
        reasonCode: this.eventInput.reasonCode,
        attempts: 1,
        maxAttempts: 3,
        ...(this.eventInput.reason !== undefined ? { reason: this.eventInput.reason } : {}),
      };
  }

  public async claimNextQueuedEvent() {
    return this.findQueuedEventById('event-1');
  }

  public async releaseEventForRetry(input: {
    readonly eventId: string;
    readonly workerId: string;
    readonly errorMessage: string;
  }): Promise<'PENDING'> {
    this.retryInput = input;
    return 'PENDING';
  }

  public async completeEvent(input: CompleteAgentLearningEventInput): Promise<AgentLearningEvent> {
    this.completed = input;
    return {
      id: input.eventId,
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      decisionId: 'decision-1',
      status: input.status,
      auditVerdict: input.auditVerdict,
      auditScore: input.auditScore,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
    };
  }

  public async createMemory(input: CreateAgentMemoryInput): Promise<AgentMemory> {
    this.memoryInput = input;
    return {
      id: 'mem-1',
      tenantId: input.tenantId,
      scope: input.scope,
      memoryType: input.memoryType,
      content: input.content,
      confidence: input.confidence,
      active: true,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
    };
  }

  public async findRecommendationLearningContext() {
    return { memoryIds: [], caseIds: [], summary: '' };
  }

  public async findSummary() {
    return {
      stats: {
        totalEvents: 0,
        feedbackApproved: 0,
        feedbackRejected: 0,
        learningPending: 0,
        learningApproved: 0,
        learningRejected: 0,
        learningSkipped: 0,
        learningError: 0,
        activeMemories: 0,
        globalMemories: 0,
        shadowMemories: 0,
      },
      memories: [],
      events: [],
    };
  }

  public async recordApprovedLearning(input: RecordApprovedLearningInput): Promise<AgentLearningEvent> {
    this.recordedApproved = input;
    this.memoryInput = input.memories[0] ?? null;
    this.completed = {
      eventId: input.eventId,
      status: 'APPROVED',
      auditVerdict: input.auditVerdict,
      auditScore: input.auditScore,
      auditReport: input.auditReport,
    };
    return {
      id: input.eventId,
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      decisionId: 'decision-1',
      status: 'APPROVED',
      auditVerdict: input.auditVerdict,
      auditScore: input.auditScore,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
    };
  }

  public async countSimilarApprovedEvents(): Promise<SimilarLearningPatternCount> {
    return this.similarPatternCount;
  }

  public async hasActiveGlobalMemory(): Promise<boolean> {
    return false;
  }

  public async promoteGlobalMemory(input: { readonly sourceLearningEventId: string }): Promise<AgentMemory | null> {
    this.promotedGlobalEventId = input.sourceLearningEventId;
    return null;
  }

  public async deactivateMemory(input: {
    readonly tenantId: string;
    readonly memoryId: string;
    readonly allowGlobal: boolean;
    readonly actorUserId: string;
  }): Promise<AgentMemory | null> {
    this.deactivatedMemoryId = input.memoryId;
    return {
      id: input.memoryId,
      tenantId: input.tenantId,
      scope: 'LOCAL',
      memoryType: 'LESSON',
      content: 'Memoria de prueba',
      confidence: 0.8,
      active: false,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
    };
  }
}

class LeakingTimeoutAiGateway implements IAiGateway {
  public readonly modelName = 'fake-model';

  public async generateText(_request: AiGatewayRequest): Promise<string> {
    throw new Error('Request timed out. apiKey=super-secret Cookie: session=super-cookie');
  }
}

describe('AgentLearningService', () => {
  test('turns a structured approval into an audited local memory', async () => {
    const learningRepository = new FakeAgentLearningRepository();
    const gateway = new FakeAiGateway();
    const service = new AgentLearningService(
      new FakeRecommendationRepository(),
      learningRepository,
      gateway,
    );

    const result = await service.processRecommendationDecision({
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      decisionId: 'decision-1',
      userId: 'user-1',
      decision: 'APPROVED',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
      reason: 'Tiene evidencia tecnica suficiente.',
    });

    expect(result).toEqual({
      status: 'APPROVED',
      eventId: 'event-1',
    });
    expect(learningRepository.eventInput).toMatchObject({
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      decisionId: 'decision-1',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
      recommendationType: 'RIGHTSIZING',
    });
    expect(gateway.lastRequest?.messages[0]?.content).toContain('auditor de aprendizaje');
    expect(learningRepository.memoryInput).toMatchObject({
      tenantId: 'tenant-1',
      scope: 'LOCAL',
      memoryType: 'APPROVAL_PATTERN',
      auditVerdict: 'APPROVED',
      auditScore: 91,
    });
    expect(learningRepository.memoryInput?.content).toContain('RIGHTSIZING');
    expect(learningRepository.completed).toMatchObject({
      eventId: 'event-1',
      status: 'APPROVED',
      auditVerdict: 'APPROVED',
      auditScore: 91,
    });
    expect(learningRepository.recordedApproved?.memories).toHaveLength(1);
  });

  test('persists recurrent global learning as an inactive shadow candidate', async () => {
    const learningRepository = new FakeAgentLearningRepository();
    learningRepository.similarPatternCount = { eventCount: 5, tenantCount: 2 };
    const service = new AgentLearningService(
      new FakeRecommendationRepository(),
      learningRepository,
      new FakeAiGateway(),
    );

    const result = await service.processRecommendationDecision({
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      decisionId: 'decision-1',
      userId: 'user-1',
      decision: 'APPROVED',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
    });

    expect(result).toMatchObject({ status: 'APPROVED', eventId: 'event-1' });
    expect(learningRepository.recordedApproved?.memories).toHaveLength(2);
    expect(learningRepository.recordedApproved?.memories[1]).toMatchObject({
      scope: 'GLOBAL',
      active: false,
      metadata: { learningLifecycle: 'SHADOW' },
    });
    expect(learningRepository.promotedGlobalEventId).toBeNull();
  });

  test('marks auditor timeouts as skipped learning instead of internal errors', async () => {
    const learningRepository = new FakeAgentLearningRepository();
    const service = new AgentLearningService(
      new FakeRecommendationRepository(),
      learningRepository,
      new TimeoutAiGateway(),
    );

    const queued = await service.queueRecommendationDecision({
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      decisionId: 'decision-1',
      userId: 'user-1',
      decision: 'APPROVED',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
    });
    const result = await service.processQueuedRecommendationDecision(queued.eventId ?? '');

    expect(result).toMatchObject({
      status: 'SKIPPED',
      eventId: 'event-1',
      error: 'Request timed out.',
    });
    expect(learningRepository.memoryInput).toBeNull();
    expect(learningRepository.completed).toMatchObject({
      eventId: 'event-1',
      status: 'SKIPPED',
      errorMessage: 'Request timed out.',
    });
  });

  test('sanitizes provider errors before persisting learning failures', async () => {
    const learningRepository = new FakeAgentLearningRepository();
    const service = new AgentLearningService(
      new FakeRecommendationRepository(),
      learningRepository,
      new LeakingTimeoutAiGateway(),
    );

    const queued = await service.queueRecommendationDecision({
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      decisionId: 'decision-1',
      userId: 'user-1',
      decision: 'APPROVED',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
    });
    const result = await service.processQueuedRecommendationDecision(queued.eventId ?? '');

    expect(result.error).toBe('Request timed out. apiKey=[REDACTED] Cookie: [REDACTED]');
    expect(result.error).not.toContain('super-secret');
    expect(result.error).not.toContain('super-cookie');
    expect(learningRepository.completed).toMatchObject({
      eventId: 'event-1',
      status: 'SKIPPED',
      errorMessage: 'Request timed out. apiKey=[REDACTED] Cookie: [REDACTED]',
    });
  });

  test('keeps external worker failures pending for durable retry', async () => {
    const learningRepository = new FakeAgentLearningRepository();
    const service = new AgentLearningService(
      new FakeRecommendationRepository(),
      learningRepository,
      new TimeoutAiGateway(),
    );
    await service.queueRecommendationDecision({
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      decisionId: 'decision-1',
      userId: 'user-1',
      decision: 'APPROVED',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
    });

    const result = await service.processNextQueuedRecommendationDecision('worker-1');

    expect(result).toMatchObject({ status: 'PENDING', eventId: 'event-1' });
    expect(learningRepository.retryInput).toMatchObject({
      eventId: 'event-1',
      workerId: 'worker-1',
      errorMessage: 'Request timed out.',
    });
    expect(learningRepository.completed).toBeNull();
  });

  test('allows an administrator to deactivate a memory without deleting its origin', async () => {
    const learningRepository = new FakeAgentLearningRepository();
    const service = new AgentLearningService(
      new FakeRecommendationRepository(),
      learningRepository,
      new FakeAiGateway(),
    );
    const actor: AuthContext = {
      userId: 'admin-1',
      tenantId: 'tenant-1',
      email: 'admin@example.com',
      role: 'ADMIN',
      jwtId: 'jwt-1',
    };

    const result = await service.deactivateMemory(actor, 'memory-1');

    expect(result).toMatchObject({ id: 'memory-1', active: false });
    expect(learningRepository.deactivatedMemoryId).toBe('memory-1');
  });

  test('does not allow a client approver to change agent memory', async () => {
    const service = new AgentLearningService(
      new FakeRecommendationRepository(),
      new FakeAgentLearningRepository(),
      new FakeAiGateway(),
    );

    await expect(service.deactivateMemory({
      userId: 'client-1',
      tenantId: 'tenant-1',
      email: 'client@example.com',
      role: 'CLIENT_APPROVER',
      jwtId: 'jwt-2',
    }, 'memory-1')).rejects.toThrow('Solo un administrador del agente puede revertir memorias');
  });
});

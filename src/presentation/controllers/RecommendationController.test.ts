import { describe, expect, test } from 'vitest';
import type { Request, Response } from 'express';
import { RecommendationController } from './RecommendationController.js';
import type {
  CreateRecommendationInput,
  CreateRecommendationDecisionInput,
  CreateRecommendationExecutionPlanInput,
  CreateRecommendationDecisionResult,
  IRecommendationRepository,
  RecommendationQuery,
} from '../../domain/interfaces/IRecommendationRepository.js';
import type {
  IAgentLearningService,
  RecommendationLearningResult,
} from '../../domain/interfaces/IAgentLearningService.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import type { RecommendationExecutionPlan } from '../../domain/models/RecommendationExecutionPlan.js';

class FakeAgentLearningService implements IAgentLearningService {
  public input: Parameters<IAgentLearningService['processRecommendationDecision']>[0] | null = null;
  public processedEventId: string | null = null;
  public result: RecommendationLearningResult = {
    status: 'PENDING',
    eventId: 'learning-event-1',
  };

  public async queueRecommendationDecision(
    input: Parameters<IAgentLearningService['processRecommendationDecision']>[0],
  ): Promise<RecommendationLearningResult> {
    this.input = input;
    return this.result;
  }

  public async processQueuedRecommendationDecision(eventId: string): Promise<RecommendationLearningResult> {
    this.processedEventId = eventId;
    return {
      status: 'APPROVED',
      eventId,
    };
  }

  public async processRecommendationDecision(
    input: Parameters<IAgentLearningService['processRecommendationDecision']>[0],
  ): Promise<RecommendationLearningResult> {
    const queued = await this.queueRecommendationDecision(input);
    return queued.eventId === undefined
      ? queued
      : this.processQueuedRecommendationDecision(queued.eventId);
  }
}

class FakeRecommendationRepository implements IRecommendationRepository {
  public decisionInput: CreateRecommendationDecisionInput | null = null;
  public tenantQuery: RecommendationQuery | null = null;
  public latestExecutionPlanQuery: { tenantId: string; recommendationId: string } | null = null;
  public latestExecutionPlan: RecommendationExecutionPlan | null = {
    id: 'plan-latest',
    recommendationId: 'rec-1',
    generatedByUserId: 'user-1',
    model: 'fake-model',
    auditorModel: 'fake-auditor',
    content: { summary: 'Plan guardado' },
    auditReport: { verdict: 'APPROVED', score: 92, checks: [], blockingIssues: [], requiredChanges: [] },
    auditVerdict: 'APPROVED',
    auditScore: 92,
    createdAt: new Date('2026-04-29T13:00:00.000Z'),
  };

  public async findByTenant(query: RecommendationQuery): Promise<FinOpsRecommendation[]> {
    this.tenantQuery = query;
    return [];
  }

  public async findById(_tenantId: string, recommendationId: string): Promise<FinOpsRecommendation | null> {
    return {
      id: recommendationId,
      cloudAccountId: 'account-focus-aws-prod',
      type: 'RIGHTSIZING',
      status: 'PENDING',
      severity: 'HIGH',
      title: 'Reducir EC2 sobredimensionado',
      description: 'Revisar EC2 con baja utilizacion.',
      evidence: {},
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

  public async findExecutionPlanById(
    _tenantId: string,
    planId: string,
  ): Promise<RecommendationExecutionPlan | null> {
    return {
      id: planId,
      recommendationId: 'rec-1',
      generatedByUserId: 'user-1',
      model: 'fake-model',
      auditorModel: 'fake-auditor',
      content: {},
      auditReport: {},
      auditVerdict: 'APPROVED',
      auditScore: 92,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
    };
  }

  public async findLatestExecutionPlanByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationExecutionPlan | null> {
    this.latestExecutionPlanQuery = { tenantId, recommendationId };
    return this.latestExecutionPlan;
  }

  public async createDecision(
    input: CreateRecommendationDecisionInput,
  ): Promise<CreateRecommendationDecisionResult> {
    this.decisionInput = input;
    return {
      decisionId: 'decision-1',
      recommendation: {
      id: input.recommendationId,
      cloudAccountId: 'account-focus-aws-prod',
      type: 'RIGHTSIZING',
      status: input.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED',
      severity: 'HIGH',
      title: 'Reducir EC2 sobredimensionado',
      description: 'Revisar EC2 con baja utilizacion.',
      evidence: {},
      estimatedMonthlySavings: 18.25,
      currency: 'USD',
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: new Date('2026-04-29T12:00:00.000Z'),
      },
    };
  }
}

describe('RecommendationController decisions', () => {
  test('filters recommendations by exact resource id within the authenticated tenant', async () => {
    const repository = new FakeRecommendationRepository();
    const controller = new RecommendationController(repository);
    const response = createResponse();

    await controller.getRecommendations(
      createRequest({ query: { externalResourceId: 'ocid1.instance.demo' } }),
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(200);
    expect(repository.tenantQuery).toEqual({
      tenantId: 'tenant-1',
      externalResourceId: 'ocid1.instance.demo',
    });
  });

  test('returns the latest execution plan scoped to the authenticated tenant and recommendation', async () => {
    const repository = new FakeRecommendationRepository();
    const controller = new RecommendationController(repository);
    const response = createResponse();

    await controller.getLatestExecutionPlan(
      createRequest(),
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      executionPlan: {
        id: 'plan-latest',
        recommendationId: 'rec-1',
      },
    });
    expect(repository.latestExecutionPlanQuery).toEqual({
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
    });
  });

  test('returns null when the recommendation has no execution plan yet', async () => {
    const repository = new FakeRecommendationRepository();
    repository.latestExecutionPlan = null;
    const controller = new RecommendationController(repository);
    const response = createResponse();

    await controller.getLatestExecutionPlan(
      createRequest(),
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      executionPlan: null,
    });
  });

  test('forbids non-admin users from deciding an execution plan', async () => {
    const repository = new FakeRecommendationRepository();
    const controller = new RecommendationController(repository);
    const response = createResponse();

    await controller.createDecision(
      createRequest({
        auth: { role: 'VIEWER' },
        body: {
          executionPlanId: 'plan-1',
          decision: 'APPROVED',
        },
      }),
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({
      success: false,
      code: 'AUTHORIZATION_FAILED',
    });
    expect(repository.decisionInput).toBeNull();
  });

  test('requires a structured reason code when rejecting an execution plan', async () => {
    const repository = new FakeRecommendationRepository();
    const controller = new RecommendationController(repository);
    const response = createResponse();

    await controller.createDecision(
      createRequest({
        body: {
          executionPlanId: 'plan-1',
          decision: 'REJECTED',
        },
      }),
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      code: 'VALIDATION_ERROR',
    });
    expect(repository.decisionInput).toBeNull();
  });

  test('requires a structured reason code when approving an execution plan', async () => {
    const repository = new FakeRecommendationRepository();
    const controller = new RecommendationController(repository);
    const response = createResponse();

    await controller.createDecision(
      createRequest({
        body: {
          executionPlanId: 'plan-1',
          decision: 'APPROVED',
        },
      }),
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      code: 'VALIDATION_ERROR',
    });
    expect(repository.decisionInput).toBeNull();
  });

  test('records an admin approval and sends structured feedback to learning', async () => {
    const repository = new FakeRecommendationRepository();
    const learningService = new FakeAgentLearningService();
    const controller = new RecommendationController(repository, undefined, learningService);
    const response = createResponse();

    await controller.createDecision(
      createRequest({
        body: {
          executionPlanId: 'plan-1',
          decision: 'APPROVED',
          reasonCode: 'APPROVED_HIGH_CONFIDENCE',
          reason: 'Validado por FinOps.',
        },
      }),
      response as unknown as Response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      recommendation: {
        id: 'rec-1',
        status: 'APPROVED',
      },
      learning: {
        status: 'PENDING',
        eventId: 'learning-event-1',
      },
    });
    expect(repository.decisionInput).toEqual({
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      executionPlanId: 'plan-1',
      userId: 'admin-1',
      decision: 'APPROVED',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
      reason: 'Validado por FinOps.',
    });
    expect(learningService.input).toEqual({
      tenantId: 'tenant-1',
      recommendationId: 'rec-1',
      decisionId: 'decision-1',
      userId: 'admin-1',
      decision: 'APPROVED',
      reasonCode: 'APPROVED_HIGH_CONFIDENCE',
      reason: 'Validado por FinOps.',
    });
    expect(learningService.processedEventId).toBeNull();
  });
});

function createRequest(input: {
  readonly auth?: { readonly role: 'ADMIN' | 'VIEWER' };
  readonly body?: unknown;
  readonly query?: Record<string, string>;
} = {}): Request {
  return {
    auth: {
      userId: 'admin-1',
      tenantId: 'tenant-1',
      email: 'admin@example.com',
      role: input.auth?.role ?? 'ADMIN',
      jwtId: 'jwt-1',
    },
    query: input.query ?? {},
    params: {
      id: 'rec-1',
    },
    body: input.body ?? {},
  } as unknown as Request;
}

function createResponse(): {
  statusCode: number;
  body: unknown;
  status: (statusCode: number) => { json: (body: unknown) => void };
  json: (body: unknown) => void;
} {
  return {
    statusCode: 200,
    body: undefined,
    status(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    json(body: unknown) {
      this.body = body;
    },
  };
}

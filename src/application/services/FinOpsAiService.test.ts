import { describe, expect, test } from 'vitest';
import { FinOpsAiService, type AiChatMessage } from './FinOpsAiService.js';
import type { IAiGateway, AiGatewayRequest } from '../../domain/interfaces/IAiGateway.js';
import type {
  CostAnalyticsSnapshot,
  ICostAnalyticsRepository,
  MonthlyUsagePoint,
} from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type {
  CreateRecommendationInput,
  IRecommendationRepository,
  RecommendationQuery,
} from '../../domain/interfaces/IRecommendationRepository.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import type {
  AgentLearningContext,
  IAgentLearningContextProvider,
} from '../../domain/interfaces/IAgentLearningService.js';

class FakeAiGateway implements IAiGateway {
  public readonly modelName = 'fake-model';
  public lastRequest: AiGatewayRequest | null = null;
  public readonly requests: AiGatewayRequest[] = [];

  constructor(private readonly responses: string | readonly string[]) {}

  public async generateText(request: AiGatewayRequest): Promise<string> {
    this.lastRequest = request;
    this.requests.push(request);

    if (Array.isArray(this.responses)) {
      const response = this.responses[this.requests.length - 1];

      if (response === undefined) {
        throw new Error('No fake AI response configured');
      }

      return response;
    }

    return this.responses;
  }
}

class FakeCostAnalyticsRepository implements ICostAnalyticsRepository {
  public async getLatestTenantSnapshot(): Promise<CostAnalyticsSnapshot> {
    return {
      tenantId: 'tenant-1',
      periodStart: '2024-09-01',
      periodEnd: '2024-10-01',
      totalCost: 117.35,
      currency: 'USD',
      metricCount: 9509,
      providers: [
        { provider: 'AWS', totalCost: 112.16, metricCount: 9441 },
      ],
      accounts: [
        {
          cloudAccountId: 'account-focus-aws-prod',
          provider: 'AWS',
          name: 'AWS Produccion FOCUS',
          totalCost: 71.4,
          metricCount: 5000,
        },
      ],
      services: [
        {
          serviceName: 'Amazon Elastic Compute Cloud',
          provider: 'AWS',
          totalCost: 52.1,
          metricCount: 3000,
        },
      ],
      environments: [
        { environment: 'prod', totalCost: 70, metricCount: 4000 },
      ],
      topResources: [
        {
          resourceId: 'i-prod-001',
          serviceName: 'Amazon Elastic Compute Cloud',
          provider: 'AWS',
          totalCost: 14.9,
          metricCount: 40,
        },
      ],
      topUsage: [
        {
          serviceName: 'Amazon Elastic Compute Cloud',
          provider: 'AWS',
          consumedQuantity: 360,
          consumedUnit: 'Hours',
          totalCost: 52.1,
          unitCost: 0.14472222,
          currency: 'USD',
          metricCount: 3000,
        },
      ],
    };
  }

  public async getMonthlyUsageSeries(): Promise<MonthlyUsagePoint[]> {
    return [];
  }
}

class FakeRecommendationRepository implements IRecommendationRepository {
  public created: readonly CreateRecommendationInput[] = [];
  public executionPlans: unknown[] = [];

  public async findByTenant(_query: RecommendationQuery): Promise<FinOpsRecommendation[]> {
    return [];
  }

  public async findById(_tenantId: string, _recommendationId: string): Promise<FinOpsRecommendation | null> {
    return {
      id: 'rec-1',
      cloudAccountId: 'account-focus-aws-prod',
      type: 'RIGHTSIZING',
      status: 'PENDING',
      severity: 'HIGH',
      title: 'Reducir EC2 sobredimensionado',
      description: 'EC2 domina el costo del periodo; revisar instancias con baja utilizacion.',
      evidence: {
        source: 'nvidia-nim',
        service: 'Amazon Elastic Compute Cloud',
        serviceCost: 52.1,
        action: 'Revisar instancias EC2 con baja utilizacion',
      },
      estimatedMonthlySavings: 18.25,
      currency: 'USD',
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: new Date('2026-04-29T12:00:00.000Z'),
    };
  }

  public async createMany(input: readonly CreateRecommendationInput[]): Promise<FinOpsRecommendation[]> {
    this.created = input;
    return input.map((item, index) => ({
      id: `rec-${index}`,
      cloudAccountId: item.cloudAccountId,
      type: item.type,
      status: 'PENDING',
      severity: item.severity,
      title: item.title,
      description: item.description,
      evidence: item.evidence,
      estimatedMonthlySavings: item.estimatedMonthlySavings,
      currency: item.currency,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: new Date('2026-04-29T12:00:00.000Z'),
    }));
  }

  public async createExecutionPlan(input: unknown): Promise<unknown> {
    this.executionPlans.push(input);
    const record = input as {
      readonly auditReport?: unknown;
      readonly auditVerdict?: 'APPROVED' | 'REJECTED' | 'NEEDS_REVISION';
      readonly auditScore?: number;
      readonly content?: unknown;
      readonly model?: string;
      readonly auditorModel?: string;
    };

    return {
      id: 'plan-1',
      recommendationId: 'rec-1',
      generatedByUserId: 'user-1',
      model: record.model ?? 'fake-model',
      auditorModel: record.auditorModel ?? 'fake-auditor',
      content: record.content ?? {},
      auditReport: record.auditReport ?? {},
      auditVerdict: record.auditVerdict ?? 'APPROVED',
      auditScore: record.auditScore ?? 92,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
    };
  }
}

class FakeLearningContextProvider implements IAgentLearningContextProvider {
  public query: Parameters<IAgentLearningContextProvider['getRecommendationLearningContext']>[0] | null = null;

  public async getRecommendationLearningContext(
    query: Parameters<IAgentLearningContextProvider['getRecommendationLearningContext']>[0],
  ): Promise<AgentLearningContext> {
    this.query = query;
    return {
      memoryIds: ['mem-1'],
      caseIds: ['decision-1'],
      summary: [
        'En casos similares se rechazaron recomendaciones sin evidencia tecnica suficiente.',
        'Prioriza recomendaciones con metrica, servicio y validacion previa explicita.',
      ].join('\n'),
    };
  }
}

describe('FinOpsAiService', () => {
  test('answers chat using a compact FinOps cost snapshot', async () => {
    const gateway = new FakeAiGateway('EC2 concentra el mayor gasto del periodo.');
    const service = new FinOpsAiService(
      new FakeCostAnalyticsRepository(),
      new FakeRecommendationRepository(),
      gateway,
    );

    const history: AiChatMessage[] = [
      { role: 'user', content: 'Que paso con septiembre?' },
    ];

    const response = await service.answerChat({
      tenantId: 'tenant-1',
      message: 'Explicame donde esta el mayor costo',
      history,
    });

    expect(response.answer).toBe('EC2 concentra el mayor gasto del periodo.');
    expect(response.snapshot.totalCost).toBe(117.35);
    expect(gateway.lastRequest?.messages[0]?.content).toContain('Amazon Elastic Compute Cloud');
    expect(gateway.lastRequest?.messages[0]?.content).toContain('español');
    expect(gateway.lastRequest?.messages.at(-1)?.content).toBe('Explicame donde esta el mayor costo');
  });

  test('generates AI recommendations only after auditor approval and persists audit evidence', async () => {
    const recommendationResponse = JSON.stringify({
      recommendations: [
        {
          cloudAccountId: 'account-focus-aws-prod',
          type: 'RIGHTSIZING',
          severity: 'HIGH',
          title: 'Reducir EC2 sobredimensionado',
          description: 'EC2 domina el costo del periodo; revisar instancias con baja utilizacion.',
          estimatedMonthlySavings: 18.25,
          currency: 'USD',
          evidence: { serviceName: 'Amazon Elastic Compute Cloud' },
        },
      ],
    });
    const auditResponse = JSON.stringify({
      verdict: 'APPROVED',
      score: 94,
      checks: [
        {
          name: 'consistencia_con_datos',
          passed: true,
          notes: 'La cuenta y el servicio existen en el contexto.',
        },
      ],
      blockingIssues: [],
      requiredChanges: [],
    });
    const gateway = new FakeAiGateway([recommendationResponse, auditResponse]);
    const recommendations = new FakeRecommendationRepository();
    const service = new FinOpsAiService(
      new FakeCostAnalyticsRepository(),
      recommendations,
      gateway,
    );

    const response = await service.generateRecommendations({
      tenantId: 'tenant-1',
      persist: true,
    });

    expect(response.recommendations).toHaveLength(1);
    expect(response.recommendations[0]?.title).toBe('Reducir EC2 sobredimensionado');
    expect(recommendations.created).toHaveLength(1);
    expect(recommendations.created[0]?.tenantId).toBe('tenant-1');
    expect(recommendations.created[0]?.evidence).toMatchObject({
      source: 'nvidia-nim',
      aiAudit: {
        verdict: 'APPROVED',
        score: 94,
      },
    });
    expect(gateway.lastRequest?.responseFormat).toBe('json');
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0]?.messages[0]?.content).toContain('español');
    expect(gateway.requests[1]?.messages[0]?.content).toContain('agente auditor');
  });

  test('uses approved learning context when generating recommendations', async () => {
    const recommendationResponse = JSON.stringify({
      recommendations: [
        {
          cloudAccountId: 'account-focus-aws-prod',
          type: 'RIGHTSIZING',
          severity: 'HIGH',
          title: 'Reducir EC2 con evidencia de utilizacion',
          description: 'Validar metricas tecnicas antes del rightsizing de EC2.',
          estimatedMonthlySavings: 18.25,
          currency: 'USD',
          evidence: { serviceName: 'Amazon Elastic Compute Cloud' },
        },
      ],
    });
    const auditResponse = JSON.stringify({
      verdict: 'APPROVED',
      score: 91,
      checks: [],
      blockingIssues: [],
      requiredChanges: [],
    });
    const gateway = new FakeAiGateway([recommendationResponse, auditResponse]);
    const recommendations = new FakeRecommendationRepository();
    const learningContextProvider = new FakeLearningContextProvider();
    const service = new FinOpsAiService(
      new FakeCostAnalyticsRepository(),
      recommendations,
      gateway,
      learningContextProvider,
    );

    await service.generateRecommendations({
      tenantId: 'tenant-1',
      persist: true,
    });

    expect(learningContextProvider.query).toMatchObject({
      tenantId: 'tenant-1',
    });
    expect(gateway.requests[0]?.messages[0]?.content).toContain('Contexto de aprendizaje auditado');
    expect(gateway.requests[0]?.messages[0]?.content).toContain('rechazaron recomendaciones sin evidencia');
    expect(recommendations.created[0]?.evidence).toMatchObject({
      aiLearning: {
        memoryIds: ['mem-1'],
        caseIds: ['decision-1'],
      },
    });
  });

  test('rejects AI recommendations when auditor finds blocking issues', async () => {
    const gateway = new FakeAiGateway([
      JSON.stringify({
        recommendations: [
          {
            cloudAccountId: 'account-focus-aws-prod',
            type: 'RIGHTSIZING',
            severity: 'HIGH',
            title: 'Reducir EC2 sobredimensionado',
            description: 'EC2 domina el costo del periodo; revisar instancias con baja utilizacion.',
            estimatedMonthlySavings: 18.25,
            currency: 'USD',
            evidence: { serviceName: 'Amazon Elastic Compute Cloud' },
          },
        ],
      }),
      JSON.stringify({
        verdict: 'REJECTED',
        score: 51,
        checks: [],
        blockingIssues: ['El ahorro no esta justificado con la evidencia.'],
        requiredChanges: ['Agregar validacion de utilizacion.'],
      }),
    ]);
    const recommendations = new FakeRecommendationRepository();
    const service = new FinOpsAiService(
      new FakeCostAnalyticsRepository(),
      recommendations,
      gateway,
    );

    await expect(service.generateRecommendations({
      tenantId: 'tenant-1',
      persist: true,
    })).rejects.toThrow('AI audit rejected recommendation output');

    expect(recommendations.created).toHaveLength(0);
  });

  test('allows one AI recommendation revision when auditor requests changes', async () => {
    const gateway = new FakeAiGateway([
      JSON.stringify({
        recommendations: [
          {
            cloudAccountId: 'account-focus-aws-prod',
            type: 'RIGHTSIZING',
            severity: 'HIGH',
            title: 'Reducir EC2',
            description: 'Revisar EC2.',
            estimatedMonthlySavings: 18.25,
            currency: 'USD',
            evidence: { serviceName: 'Amazon Elastic Compute Cloud' },
          },
        ],
      }),
      JSON.stringify({
        verdict: 'NEEDS_REVISION',
        score: 72,
        checks: [],
        blockingIssues: [],
        requiredChanges: ['Agregar validaciones previas y rollback.'],
      }),
      JSON.stringify({
        recommendations: [
          {
            cloudAccountId: 'account-focus-aws-prod',
            type: 'RIGHTSIZING',
            severity: 'HIGH',
            title: 'Reducir EC2 con validacion previa',
            description: 'Revisar utilizacion antes del cambio y documentar rollback.',
            estimatedMonthlySavings: 18.25,
            currency: 'USD',
            evidence: { serviceName: 'Amazon Elastic Compute Cloud' },
          },
        ],
      }),
      JSON.stringify({
        verdict: 'APPROVED',
        score: 88,
        checks: [],
        blockingIssues: [],
        requiredChanges: [],
      }),
    ]);
    const recommendations = new FakeRecommendationRepository();
    const service = new FinOpsAiService(
      new FakeCostAnalyticsRepository(),
      recommendations,
      gateway,
    );

    const response = await service.generateRecommendations({
      tenantId: 'tenant-1',
      persist: true,
    });

    expect(response.recommendations[0]?.title).toBe('Reducir EC2 con validacion previa');
    expect(gateway.requests).toHaveLength(4);
    expect(gateway.requests[2]?.messages.at(-1)?.content).toContain('Agregar validaciones previas y rollback');
  });

  test('generates an audited execution plan for an existing recommendation', async () => {
    const planResponse = JSON.stringify({
      summary: 'Reducir capacidad EC2 despues de validar baja utilizacion.',
      scope: {
        cloudAccountId: 'account-focus-aws-prod',
        service: 'Amazon Elastic Compute Cloud',
      },
      prerequisites: ['Confirmar ventana de mantenimiento con el dueno del servicio.'],
      steps: ['Revisar metricas de CPU y memoria de los ultimos 14 dias.'],
      validation: ['Comparar costo diario antes y despues del cambio.'],
      risks: ['Posible degradacion si la instancia esta subdimensionada.'],
      rollback: ['Restaurar el tamano anterior de la instancia.'],
      successCriteria: ['Ahorro mensual cercano a 18.25 USD sin degradacion.'],
      estimatedSavings: {
        amount: 18.25,
        currency: 'USD',
      },
    });
    const auditResponse = JSON.stringify({
      verdict: 'APPROVED',
      score: 92,
      checks: [
        {
          name: 'rollback',
          passed: true,
          notes: 'Incluye restauracion del tamano anterior.',
        },
      ],
      blockingIssues: [],
      requiredChanges: [],
    });
    const gateway = new FakeAiGateway([planResponse, auditResponse]);
    const recommendations = new FakeRecommendationRepository();
    const service = new FinOpsAiService(
      new FakeCostAnalyticsRepository(),
      recommendations,
      gateway,
    );

    const result = await service.generateExecutionPlan({
      tenantId: 'tenant-1',
      userId: 'user-1',
      recommendationId: 'rec-1',
    });

    expect(result.auditVerdict).toBe('APPROVED');
    expect(recommendations.executionPlans).toHaveLength(1);
    expect(recommendations.executionPlans[0]).toMatchObject({
      recommendationId: 'rec-1',
      generatedByUserId: 'user-1',
      auditVerdict: 'APPROVED',
      auditScore: 92,
    });
    expect(gateway.requests[0]?.messages[0]?.content).toContain('plan de ejecucion');
    expect(gateway.requests[1]?.messages[0]?.content).toContain('agente auditor');
  });

  test('persists and returns rejected execution plans so they can be inspected', async () => {
    const gateway = new FakeAiGateway([
      JSON.stringify({
        summary: 'Reducir capacidad EC2 despues de validar baja utilizacion.',
        scope: {
          cloudAccountId: 'account-focus-aws-prod',
          service: 'Amazon Elastic Compute Cloud',
        },
        prerequisites: ['Confirmar ventana de mantenimiento.'],
        steps: ['Cambiar la instancia sin validar metricas suficientes.'],
        validation: ['Comparar costo diario antes y despues del cambio.'],
        risks: ['Posible degradacion si la instancia esta subdimensionada.'],
        rollback: ['Restaurar el tamano anterior de la instancia.'],
        successCriteria: ['Ahorro mensual cercano a 18.25 USD.'],
        estimatedSavings: {
          amount: 18.25,
          currency: 'USD',
        },
      }),
      JSON.stringify({
        verdict: 'REJECTED',
        score: 58,
        checks: [
          {
            name: 'viabilidad_tecnica',
            passed: false,
            notes: 'El plan no exige validar utilizacion antes del cambio.',
          },
        ],
        blockingIssues: ['Falta validacion previa obligatoria de utilizacion.'],
        requiredChanges: ['Agregar validacion de CPU y memoria antes del cambio.'],
      }),
    ]);
    const recommendations = new FakeRecommendationRepository();
    const service = new FinOpsAiService(
      new FakeCostAnalyticsRepository(),
      recommendations,
      gateway,
    );

    const result = await service.generateExecutionPlan({
      tenantId: 'tenant-1',
      userId: 'user-1',
      recommendationId: 'rec-1',
    });

    expect(result.auditVerdict).toBe('REJECTED');
    expect(result.auditScore).toBe(58);
    expect(recommendations.executionPlans).toHaveLength(1);
    expect(recommendations.executionPlans[0]).toMatchObject({
      recommendationId: 'rec-1',
      auditVerdict: 'REJECTED',
      auditScore: 58,
    });
  });
});

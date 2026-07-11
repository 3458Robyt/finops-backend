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
import type { TechnicalRecommendationEvidenceProvider } from './ai/TechnicalRecommendationEvidenceService.js';
import type { RecommendationEvidenceSnapshot } from './ai/RecommendationEvidenceSnapshot.js';

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

class FakeTechnicalEvidenceProvider implements TechnicalRecommendationEvidenceProvider {
  public async buildRecommendationEvidenceSnapshot(): Promise<RecommendationEvidenceSnapshot> {
    const rule = {
      externalResourceId: 'i-prod-001',
      cloudResourceId: 'resource-1',
      provider: 'AWS',
      readiness: 'GENERATABLE' as const,
      evidenceStrength: 'HIGH' as const,
      recommendedActionType: 'RIGHTSIZING' as const,
      ruleMatches: ['CPU_STRONG_UNDERUTILIZATION', 'MEMORY_LOW_UTILIZATION'],
      blockers: [],
      sourceFacts: ['CPU y memoria bajos con cobertura suficiente.'],
      technicalEvidenceRefs: ['resource_metric_samples:i-prod-001:CpuUtilization:2024-09-30T00:00:00.000Z'],
      metricSummary: [],
      maxTechnicalSavingsRate: 0.25,
    };
    return {
      version: '1',
      hash: 'technical-snapshot-hash',
      tenantId: 'tenant-1',
      periodStart: '2024-09-01',
      periodEnd: '2024-10-01',
      generatedAt: '2024-10-01T00:00:00.000Z',
      availability: 'COST_USAGE_AND_TECHNICAL_AVAILABLE',
      resources: [{
        externalResourceId: 'i-prod-001',
        cloudResourceId: 'resource-1',
        provider: 'AWS',
        serviceName: 'Amazon Elastic Compute Cloud',
        linkQuality: 'COST_AND_TECHNICAL',
        cost: { totalCost: 14.9, currency: 'USD', focusMetricCount: 40 },
        usage: [],
        metrics: [{
          metricName: 'CpuUtilization', metricUnit: 'Percent', sampleCount: 96, coverageDays: 14,
          min: 1, max: 25, avg: 8, p50: 8, p95: 15, p99: 25, latest: 8,
          firstSampledAt: '2024-09-16T00:00:00.000Z', latestSampledAt: '2024-09-30T00:00:00.000Z',
          evidenceRef: 'resource_metric_samples:i-prod-001:CpuUtilization:2024-09-30T00:00:00.000Z',
        }],
        ruleEvaluation: rule,
      }],
      deterministicRules: [rule],
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
          evidence: {
            serviceName: 'Amazon Elastic Compute Cloud',
            evidenceLevel: 'COST_ONLY',
            requiresTechnicalValidation: true,
          },
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
    expect(recommendations.created[0]?.deduplicationKey).toMatch(/^[a-f0-9]{64}$/);
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
          evidence: {
            serviceName: 'Amazon Elastic Compute Cloud',
            evidenceLevel: 'COST_ONLY',
            requiresTechnicalValidation: true,
          },
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

  test('persists and audits the same canonical technical evidence snapshot', async () => {
    const gateway = new FakeAiGateway([
      JSON.stringify({
        recommendations: [{
          cloudAccountId: 'account-focus-aws-prod',
          type: 'RIGHTSIZING',
          severity: 'MEDIUM',
          title: 'Reducir capacidad de la instancia',
          description: 'La instancia presenta CPU y memoria bajas con cobertura técnica suficiente.',
          estimatedMonthlySavings: 3.7,
          currency: 'USD',
          evidence: {
            candidateId: 'resource-1',
            externalResourceId: 'i-prod-001',
            cloudResourceId: 'resource-1',
            evidenceLevel: 'COST_USAGE_AND_TECHNICAL',
            technicalEvidenceRefs: ['resource_metric_samples:i-prod-001:CpuUtilization:2024-09-30T00:00:00.000Z'],
            technicalSampleCount: 96,
            technicalCoverageDays: 14,
            latestTechnicalSampleAt: '2024-09-30T00:00:00.000Z',
          },
        }],
      }),
      JSON.stringify({ verdict: 'APPROVED', score: 95, checks: [], blockingIssues: [], requiredChanges: [] }),
    ]);
    const recommendations = new FakeRecommendationRepository();
    const service = new FinOpsAiService(
      new FakeCostAnalyticsRepository(),
      recommendations,
      gateway,
      undefined,
      undefined,
      undefined,
      new FakeTechnicalEvidenceProvider(),
    );

    await service.generateRecommendations({ tenantId: 'tenant-1', persist: true, externalResourceId: 'i-prod-001' });

    expect(gateway.requests[0]?.messages[0]?.content).toContain('technical-snapshot-hash');
    expect(gateway.requests[1]?.messages.at(-1)?.content).toContain('Evidencia tecnica canonica');
    expect(recommendations.created[0]?.evidence).toMatchObject({
      recommendationEvidenceSnapshot: { hash: 'technical-snapshot-hash' },
      aiAudit: { verdict: 'APPROVED' },
    });
  });

  test('uses audited learning context for a resource-scoped recommendation without broadening factual scope', async () => {
    const gateway = new FakeAiGateway([
      JSON.stringify({
        recommendations: [{
          cloudAccountId: 'account-focus-aws-prod',
          type: 'TECHNICAL_VALIDATION_REQUIRED',
          severity: 'MEDIUM',
          title: 'Validar la instancia solicitada',
          description: 'Validar métricas técnicas antes de cambiar la capacidad del recurso.',
          estimatedMonthlySavings: 0,
          currency: 'USD',
          evidence: {
            candidateId: 'resource-1',
            externalResourceId: 'i-prod-001',
            evidenceLevel: 'COST_ONLY',
            requiresTechnicalValidation: true,
          },
        }],
      }),
      JSON.stringify({ verdict: 'APPROVED', score: 92, checks: [], blockingIssues: [], requiredChanges: [] }),
    ]);
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
      externalResourceId: 'i-prod-001',
    });

    expect(learningContextProvider.query?.tenantId).toBe('tenant-1');
    expect(gateway.requests[0]?.messages[0]?.content).toContain('rechazaron recomendaciones sin evidencia');
    expect(gateway.requests[0]?.messages[0]?.content).toContain('i-prod-001');
    expect(recommendations.created[0]?.evidence).toMatchObject({
      aiLearning: { memoryIds: ['mem-1'], caseIds: ['decision-1'] },
    });
  });

  test('compares generation with and without learning while preserving the same scoped facts', async () => {
    const response = JSON.stringify({
      recommendations: [{
        cloudAccountId: 'account-focus-aws-prod', type: 'TECHNICAL_VALIDATION_REQUIRED', severity: 'LOW',
        title: 'Validar la instancia solicitada', description: 'Validar métricas antes de cambiar capacidad.',
        estimatedMonthlySavings: 0, currency: 'USD',
        evidence: { externalResourceId: 'i-prod-001', evidenceLevel: 'COST_ONLY', requiresTechnicalValidation: true },
      }],
    });
    const audit = JSON.stringify({ verdict: 'APPROVED', score: 90, checks: [], blockingIssues: [], requiredChanges: [] });
    const baselineGateway = new FakeAiGateway([response, audit]);
    const learnedGateway = new FakeAiGateway([response, audit]);
    const baselineRepository = new FakeRecommendationRepository();
    const learnedRepository = new FakeRecommendationRepository();

    await new FinOpsAiService(new FakeCostAnalyticsRepository(), baselineRepository, baselineGateway)
      .generateRecommendations({ tenantId: 'tenant-1', persist: true, externalResourceId: 'i-prod-001' });
    await new FinOpsAiService(
      new FakeCostAnalyticsRepository(), learnedRepository, learnedGateway, new FakeLearningContextProvider(),
    ).generateRecommendations({ tenantId: 'tenant-1', persist: true, externalResourceId: 'i-prod-001' });

    expect(baselineGateway.requests[0]?.messages[0]?.content).toContain('no hay patrones previos relevantes');
    expect(learnedGateway.requests[0]?.messages[0]?.content).toContain('rechazaron recomendaciones sin evidencia');
    expect((baselineRepository.created[0]?.evidence as { externalResourceId?: string }).externalResourceId).toBe('i-prod-001');
    expect((learnedRepository.created[0]?.evidence as { externalResourceId?: string }).externalResourceId).toBe('i-prod-001');
    expect(learnedRepository.created[0]?.evidence).toMatchObject({ aiLearning: { memoryIds: ['mem-1'] } });
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
            evidence: {
              serviceName: 'Amazon Elastic Compute Cloud',
              evidenceLevel: 'COST_ONLY',
              requiresTechnicalValidation: true,
            },
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

  test('rejects an auditor-approved recommendation when deterministic evidence is insufficient', async () => {
    const gateway = new FakeAiGateway([
      JSON.stringify({
        recommendations: [{
          cloudAccountId: 'account-focus-aws-prod',
          type: 'RIGHTSIZING',
          severity: 'HIGH',
          title: 'Reducir EC2 sin evidencia',
          description: 'Cambiar capacidad sin validacion tecnica previa.',
          estimatedMonthlySavings: 18.25,
          currency: 'USD',
          evidence: { serviceName: 'Amazon Elastic Compute Cloud', evidenceLevel: 'COST_ONLY' },
        }],
      }),
      JSON.stringify({
        verdict: 'APPROVED',
        score: 99,
        checks: [],
        blockingIssues: [],
        requiredChanges: [],
      }),
    ]);
    const recommendations = new FakeRecommendationRepository();
    const service = new FinOpsAiService(new FakeCostAnalyticsRepository(), recommendations, gateway);

    await expect(service.generateRecommendations({ tenantId: 'tenant-1', persist: true }))
      .rejects.toThrow('AI audit rejected recommendation output');
    expect(recommendations.created).toHaveLength(0);
  });

  test('rejects a scoped analysis before calling the LLM when the resource is absent from the tenant snapshot', async () => {
    const gateway = new FakeAiGateway('not used');
    const service = new FinOpsAiService(
      new FakeCostAnalyticsRepository(),
      new FakeRecommendationRepository(),
      gateway,
    );

    await expect(service.generateRecommendations({
      tenantId: 'tenant-1',
      persist: false,
      externalResourceId: 'i-other-tenant',
    })).rejects.toThrow('No existe evidencia de costo para el recurso solicitado');

    expect(gateway.requests).toHaveLength(0);
  });

  test('rejects an auditor-approved scoped output that points to another resource', async () => {
    const gateway = new FakeAiGateway([
      JSON.stringify({
        recommendations: [{
          cloudAccountId: 'account-focus-aws-prod',
          type: 'RIGHTSIZING',
          severity: 'LOW',
          title: 'Validar instancia distinta',
          description: 'Revisar métricas antes de cambiar capacidad.',
          estimatedMonthlySavings: 0,
          currency: 'USD',
          evidence: {
            candidateId: 'resource-i-prod-001',
            evidenceLevel: 'COST_ONLY',
            requiresTechnicalValidation: true,
            externalResourceId: 'i-other-resource',
            sourceFacts: ['El recurso solicitado debe validarse antes de cambiar capacidad.'],
            assumptions: ['No se aplicará cambio automático.'],
            confidence: 0.4,
          },
        }],
      }),
      JSON.stringify({ verdict: 'APPROVED', score: 99, checks: [], blockingIssues: [], requiredChanges: [] }),
    ]);
    const recommendations = new FakeRecommendationRepository();
    const service = new FinOpsAiService(new FakeCostAnalyticsRepository(), recommendations, gateway);

    await expect(service.generateRecommendations({
      tenantId: 'tenant-1',
      persist: true,
      externalResourceId: 'i-prod-001',
    })).rejects.toThrow('AI audit rejected recommendation output');

    expect(recommendations.created).toHaveLength(0);
    expect(gateway.requests[0]?.messages[0]?.content).toContain('evidence.externalResourceId="i-prod-001"');
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
            evidence: {
              serviceName: 'Amazon Elastic Compute Cloud',
              evidenceLevel: 'COST_ONLY',
              requiresTechnicalValidation: true,
            },
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
            evidence: {
              serviceName: 'Amazon Elastic Compute Cloud',
              evidenceLevel: 'COST_ONLY',
              requiresTechnicalValidation: true,
            },
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

  test('rejects an execution plan without persisting it when the auditor rejects it', async () => {
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

    await expect(service.generateExecutionPlan({
      tenantId: 'tenant-1',
      userId: 'user-1',
      recommendationId: 'rec-1',
    })).rejects.toThrow('AI audit rejected execution plan output');

    expect(recommendations.executionPlans).toHaveLength(0);
  });
});

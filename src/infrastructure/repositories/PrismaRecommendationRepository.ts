import type {
  CreateRecommendationDecisionInput,
  CreateRecommendationDecisionResult,
  CreateRecommendationExecutionPlanInput,
  CreateRecommendationInput,
  CreateManualExecutionInput,
  AdoptionKpis,
  IRecommendationRepository,
  RecommendationManualExecution,
  RecommendationQuery,
  RecommendationTimelineEvent,
  SavingsKpis,
} from '../../domain/interfaces/IRecommendationRepository.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import type { RecommendationExecutionPlan } from '../../domain/models/RecommendationExecutionPlan.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

export class PrismaRecommendationRepository implements IRecommendationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findById(tenantId: string, recommendationId: string): Promise<FinOpsRecommendation | null> {
    const row = await this.prisma.recommendation.findFirst({
      where: {
        id: recommendationId,
        tenantId,
      },
    });

    return row === null ? null : this.toDomain(row);
  }

  public async findByTenant(query: RecommendationQuery): Promise<FinOpsRecommendation[]> {
    const rows = await this.prisma.recommendation.findMany({
      where: {
        tenantId: query.tenantId,
        ...(query.cloudAccountId !== undefined ? { cloudAccountId: query.cloudAccountId } : {}),
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      orderBy: [
        { createdAt: 'desc' },
      ],
    });

    return rows.map((row) => this.toDomain(row));
  }

  public async createMany(input: readonly CreateRecommendationInput[]): Promise<FinOpsRecommendation[]> {
    if (input.length === 0) {
      return [];
    }

    const rows = await Promise.all(input.map((item) => (
      this.prisma.recommendation.create({
        data: {
          tenantId: item.tenantId,
          cloudAccountId: item.cloudAccountId,
          type: item.type,
          severity: item.severity,
          status: 'PENDING',
          title: item.title,
          description: item.description,
          evidence: item.evidence as Prisma.InputJsonValue,
          ...(item.estimatedMonthlySavings !== undefined
            ? { estimatedMonthlySavings: item.estimatedMonthlySavings }
            : {}),
          currency: item.currency,
        },
      })
    )));

    return rows.map((row) => this.toDomain(row));
  }

  public async createExecutionPlan(
    input: CreateRecommendationExecutionPlanInput,
  ): Promise<RecommendationExecutionPlan> {
    const row = await this.prisma.recommendationExecutionPlan.create({
      data: {
        recommendationId: input.recommendationId,
        generatedByUserId: input.generatedByUserId,
        model: input.model,
        auditorModel: input.auditorModel,
        content: input.content as Prisma.InputJsonValue,
        auditReport: input.auditReport as unknown as Prisma.InputJsonValue,
        auditVerdict: input.auditVerdict,
        auditScore: input.auditScore,
      },
    });

    return this.toExecutionPlanDomain(row);
  }

  public async findExecutionPlanById(
    tenantId: string,
    executionPlanId: string,
  ): Promise<RecommendationExecutionPlan | null> {
    const row = await this.prisma.recommendationExecutionPlan.findFirst({
      where: {
        id: executionPlanId,
        recommendation: {
          tenantId,
        },
      },
    });

    return row === null ? null : this.toExecutionPlanDomain(row);
  }

  public async findLatestExecutionPlanByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationExecutionPlan | null> {
    const row = await this.prisma.recommendationExecutionPlan.findFirst({
      where: {
        recommendationId,
        recommendation: {
          tenantId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return row === null ? null : this.toExecutionPlanDomain(row);
  }

  public async createDecision(
    input: CreateRecommendationDecisionInput,
  ): Promise<CreateRecommendationDecisionResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      const recommendation = await tx.recommendation.findFirst({
        where: {
          id: input.recommendationId,
          tenantId: input.tenantId,
        },
      });

      if (recommendation === null) {
        throw new Error('Recommendation not found');
      }

      const decision = await tx.recommendationDecision.create({
        data: {
          recommendationId: input.recommendationId,
          ...(input.executionPlanId !== undefined ? { executionPlanId: input.executionPlanId } : {}),
          userId: input.userId,
          decision: input.decision,
          ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
          learningStatus: 'PENDING',
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
      });

      const updatedRecommendation = await tx.recommendation.update({
        where: {
          id: input.recommendationId,
        },
        data: {
          status: input.decision === 'MARKED_DONE'
            ? 'MANUAL_COMPLETED'
            : input.decision,
        },
      });

      return {
        decisionId: decision.id,
        recommendation: updatedRecommendation,
      };
    });

    return {
      decisionId: result.decisionId,
      recommendation: this.toDomain(result.recommendation),
    };
  }

  public async createManualExecution(
    input: CreateManualExecutionInput,
  ): Promise<RecommendationManualExecution> {
    const result = await this.prisma.$transaction(async (tx) => {
      const recommendation = await tx.recommendation.findFirst({
        where: {
          id: input.recommendationId,
          tenantId: input.tenantId,
        },
      });

      if (recommendation === null) {
        throw new Error('Recommendation not found');
      }

      if (recommendation.status !== 'APPROVED' && recommendation.status !== 'MANUAL_COMPLETED') {
        throw new Error('Only approved recommendations can be manually executed');
      }

      if (input.executionPlanId !== undefined) {
        const plan = await tx.recommendationExecutionPlan.findFirst({
          where: {
            id: input.executionPlanId,
            recommendationId: input.recommendationId,
          },
        });

        if (plan === null) {
          throw new Error('Execution plan not found for recommendation');
        }
      }

      const execution = await tx.recommendationManualExecution.create({
        data: {
          tenantId: input.tenantId,
          recommendationId: input.recommendationId,
          ...(input.executionPlanId !== undefined ? { executionPlanId: input.executionPlanId } : {}),
          userId: input.userId,
          status: input.status,
          ...(input.executedAt !== undefined ? { executedAt: input.executedAt } : {}),
          ...(input.observedMonthlySavings !== undefined
            ? { observedMonthlySavings: input.observedMonthlySavings }
            : {}),
          currency: input.currency,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.evidence !== undefined ? { evidence: input.evidence as Prisma.InputJsonValue } : {}),
        },
      });

      if (input.status === 'EXECUTED') {
        await tx.recommendation.update({
          where: { id: input.recommendationId },
          data: { status: 'MANUAL_COMPLETED' },
        });
      }

      return execution;
    });

    return this.toManualExecutionDomain(result);
  }

  public async findManualExecutionsByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationManualExecution[]> {
    const rows = await this.prisma.recommendationManualExecution.findMany({
      where: {
        tenantId,
        recommendationId,
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => this.toManualExecutionDomain(row));
  }

  public async findTimelineByRecommendation(
    tenantId: string,
    recommendationId: string,
  ): Promise<RecommendationTimelineEvent[]> {
    const recommendation = await this.prisma.recommendation.findFirst({
      where: { tenantId, id: recommendationId },
    });

    if (recommendation === null) {
      return [];
    }

    const [plans, decisions, executions, learningEvents] = await Promise.all([
      this.prisma.recommendationExecutionPlan.findMany({
        where: { recommendationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.recommendationDecision.findMany({
        where: { recommendationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.recommendationManualExecution.findMany({
        where: { tenantId, recommendationId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.agentLearningEvent.findMany({
        where: { tenantId, recommendationId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const events: RecommendationTimelineEvent[] = [
      {
        id: recommendation.id,
        type: 'RECOMMENDATION_CREATED',
        title: 'Recomendacion generada',
        description: recommendation.title,
        createdAt: recommendation.createdAt,
        metadata: this.toDomain(recommendation),
      },
      ...plans.map((plan): RecommendationTimelineEvent => ({
        id: plan.id,
        type: 'PLAN_GENERATED',
        title: 'Plan de ejecucion auditado',
        description: `Auditoria ${plan.auditVerdict} con score ${plan.auditScore}/100`,
        createdAt: plan.createdAt,
        metadata: this.toExecutionPlanDomain(plan),
      })),
      ...decisions.map((decision): RecommendationTimelineEvent => ({
        id: decision.id,
        type: 'DECISION_RECORDED',
        title: decision.decision === 'APPROVED' ? 'Recomendacion aprobada' : 'Recomendacion rechazada',
        description: decision.reason ?? decision.reasonCode ?? decision.decision,
        createdAt: decision.createdAt,
        metadata: {
          decision: decision.decision,
          reasonCode: decision.reasonCode,
          executionPlanId: decision.executionPlanId,
        },
      })),
      ...executions.map((execution): RecommendationTimelineEvent => ({
        id: execution.id,
        type: 'MANUAL_EXECUTION_RECORDED',
        title: 'Ejecucion manual registrada',
        description: execution.notes ?? `Estado ${execution.status}`,
        createdAt: execution.createdAt,
        metadata: this.toManualExecutionDomain(execution),
      })),
      ...learningEvents.map((event): RecommendationTimelineEvent => ({
        id: event.id,
        type: 'LEARNING_EVENT',
        title: this.learningTimelineTitle(event.status),
        description: this.learningTimelineDescription(event.status, event.errorMessage),
        createdAt: event.createdAt,
        metadata: {
          status: event.status,
          auditVerdict: event.auditVerdict,
          auditScore: event.auditScore,
          reasonCode: event.reasonCode,
          errorMessage: event.errorMessage,
        },
      })),
    ];

    return events.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  public async getSavingsKpis(tenantId: string): Promise<SavingsKpis> {
    const [estimated, observed, executed, pendingSavings] = await Promise.all([
      this.prisma.recommendation.aggregate({
        where: { tenantId },
        _sum: { estimatedMonthlySavings: true },
      }),
      this.prisma.recommendationManualExecution.aggregate({
        where: {
          tenantId,
          status: { in: ['EXECUTED', 'PARTIAL'] },
        },
        _sum: { observedMonthlySavings: true },
      }),
      this.prisma.recommendationManualExecution.groupBy({
        by: ['recommendationId'],
        where: {
          tenantId,
          status: { in: ['EXECUTED', 'PARTIAL'] },
        },
      }),
      this.prisma.recommendation.findMany({
        where: {
          tenantId,
          status: { in: ['PENDING', 'APPROVED'] },
          estimatedMonthlySavings: { gt: 0 },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const observedMonthlySavings = Number(observed._sum.observedMonthlySavings ?? 0);
    const missedSavings = pendingSavings
      .map((recommendation) => ({
        recommendation,
        missedSavingsAmount: this.calculateMissedSavings(
          Number(recommendation.estimatedMonthlySavings ?? 0),
          recommendation.createdAt,
        ),
      }))
      .filter((item) => item.missedSavingsAmount > 0.01);
    const missedSavingsAmount = roundCurrency(
      missedSavings.reduce((total, item) => total + item.missedSavingsAmount, 0),
    );
    const topMissed = missedSavings
      .sort((left, right) => right.missedSavingsAmount - left.missedSavingsAmount)[0];

    return {
      estimatedMonthlySavings: Number(estimated._sum.estimatedMonthlySavings ?? 0),
      observedMonthlySavings,
      confirmedMonthlySavings: observedMonthlySavings,
      missedSavingsAmount,
      currency: 'USD',
      executedRecommendations: executed.length,
      pendingSavingsRecommendations: pendingSavings.length,
      ...(topMissed !== undefined
        ? {
            topMissedSavingsRecommendation: {
              id: topMissed.recommendation.id,
              title: topMissed.recommendation.title,
              missedSavingsAmount: topMissed.missedSavingsAmount,
              estimatedMonthlySavings: Number(topMissed.recommendation.estimatedMonthlySavings ?? 0),
              currency: topMissed.recommendation.currency,
              createdAt: topMissed.recommendation.createdAt,
              status: topMissed.recommendation.status,
            },
          }
        : {}),
    };
  }

  public async getAdoptionKpis(tenantId: string): Promise<AdoptionKpis> {
    const grouped = await this.prisma.recommendation.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: true,
    });
    const counts = new Map(grouped.map((row) => [row.status, row._count]));
    const totalRecommendations = grouped.reduce((total, row) => total + row._count, 0);
    const approvedRecommendations = counts.get('APPROVED') ?? 0;
    const rejectedRecommendations = counts.get('REJECTED') ?? 0;
    const completedRecommendations = counts.get('MANUAL_COMPLETED') ?? 0;
    const decided = approvedRecommendations + rejectedRecommendations + completedRecommendations;

    return {
      totalRecommendations,
      pendingRecommendations: counts.get('PENDING') ?? 0,
      approvedRecommendations,
      rejectedRecommendations,
      completedRecommendations,
      acceptanceRate: decided > 0 ? (approvedRecommendations + completedRecommendations) / decided : 0,
      rejectionRate: decided > 0 ? rejectedRecommendations / decided : 0,
      executionRate: totalRecommendations > 0 ? completedRecommendations / totalRecommendations : 0,
    };
  }

  private toDomain(row: Awaited<ReturnType<PrismaClient['recommendation']['findFirst']>> & {}): FinOpsRecommendation {
    return {
      id: row.id,
      cloudAccountId: row.cloudAccountId,
      type: row.type,
      status: row.status,
      severity: row.severity,
      title: row.title,
      description: row.description,
      evidence: row.evidence,
      ...(row.estimatedMonthlySavings !== null
        ? { estimatedMonthlySavings: Number(row.estimatedMonthlySavings) }
        : {}),
      currency: row.currency,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toExecutionPlanDomain(row: Awaited<ReturnType<PrismaClient['recommendationExecutionPlan']['findFirst']>> & {}): RecommendationExecutionPlan {
    return {
      id: row.id,
      recommendationId: row.recommendationId,
      generatedByUserId: row.generatedByUserId,
      model: row.model,
      auditorModel: row.auditorModel,
      content: row.content,
      auditReport: row.auditReport,
      auditVerdict: row.auditVerdict,
      auditScore: row.auditScore,
      createdAt: row.createdAt,
    };
  }

  private toManualExecutionDomain(
    row: Awaited<ReturnType<PrismaClient['recommendationManualExecution']['findFirst']>> & {},
  ): RecommendationManualExecution {
    return {
      id: row.id,
      tenantId: row.tenantId,
      recommendationId: row.recommendationId,
      ...(row.executionPlanId !== null ? { executionPlanId: row.executionPlanId } : {}),
      userId: row.userId,
      status: row.status,
      ...(row.executedAt !== null ? { executedAt: row.executedAt } : {}),
      ...(row.observedMonthlySavings !== null
        ? { observedMonthlySavings: Number(row.observedMonthlySavings) }
        : {}),
      currency: row.currency,
      ...(row.notes !== null ? { notes: row.notes } : {}),
      ...(row.evidence !== null ? { evidence: row.evidence } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private learningTimelineTitle(status: string): string {
    const titles: Record<string, string> = {
      PENDING: 'Aprendizaje en cola',
      APPROVED: 'Aprendizaje registrado',
      REJECTED: 'Memoria descartada por auditor',
      SKIPPED: 'Aprendizaje omitido temporalmente',
      ERROR: 'Error interno de aprendizaje',
    };

    return titles[status] ?? 'Aprendizaje del agente';
  }

  private learningTimelineDescription(status: string, errorMessage: string | null): string {
    const descriptions: Record<string, string> = {
      PENDING: 'La decision ya fue guardada. El agente procesara el aprendizaje en segundo plano.',
      APPROVED: 'El auditor aprobo la memoria y el agente incorporo el aprendizaje.',
      REJECTED: 'El auditor IA descarto la memoria para evitar aprendizaje incorrecto.',
      SKIPPED: 'El auditor IA no respondio de forma confiable a tiempo. La decision humana sigue guardada.',
      ERROR: 'Ocurrio un error interno procesando el aprendizaje. La decision humana sigue guardada.',
    };

    if (status === 'ERROR' && errorMessage !== null && errorMessage.trim() !== '') {
      return `${descriptions[status]} Detalle: ${errorMessage}`;
    }

    return descriptions[status] ?? `Estado ${status}`;
  }

  private calculateMissedSavings(estimatedMonthlySavings: number, createdAt: Date): number {
    const elapsedDays = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / (24 * 60 * 60 * 1000)));
    return roundCurrency((estimatedMonthlySavings / 30) * elapsedDays);
  }
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

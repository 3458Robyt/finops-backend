/**
 * ═══════════════════════════════════════════════════════════════
 * Ensamblado de la línea de tiempo de una recomendación
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla la lógica pura de combinación y ordenación cronológica de los eventos
 * del ciclo de vida de una recomendación (creación, planes de ejecución,
 * decisiones, ejecuciones manuales y eventos de aprendizaje del agente). El
 * repositorio sigue siendo responsable de cargar las filas desde Prisma y de la
 * verificación de tenant (aislamiento multi-tenant); este módulo solo arma y
 * ordena el array {@link RecommendationTimelineEvent}[].
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 *
 * @module infrastructure/repositories/queries/recommendationTimelineBuilder
 */
import type { RecommendationTimelineEvent } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import {
  learningTimelineDescription,
  learningTimelineTitle,
  toDomain,
  toExecutionPlanDomain,
  toManualExecutionDomain,
} from '../mappers/recommendationMappers.js';

type RecommendationRow = Awaited<ReturnType<PrismaClient['recommendation']['findFirst']>> & {};
type ExecutionPlanRows = Awaited<ReturnType<PrismaClient['recommendationExecutionPlan']['findMany']>>;
type DecisionRows = Awaited<ReturnType<PrismaClient['recommendationDecision']['findMany']>>;
type ManualExecutionRows = Awaited<ReturnType<PrismaClient['recommendationManualExecution']['findMany']>>;
type LearningEventRows = Awaited<ReturnType<PrismaClient['agentLearningEvent']['findMany']>>;

/**
 * Construye una línea de tiempo unificada y cronológica de todos los eventos de
 * una recomendación a partir de las filas ya cargadas desde Prisma.
 *
 * Combina en eventos homogéneos {@link RecommendationTimelineEvent} el evento
 * sintético de creación de la recomendación junto con los planes de ejecución,
 * decisiones, ejecuciones manuales y eventos de aprendizaje del agente, y
 * finalmente ordena todos los eventos por `createdAt` ascendente.
 *
 * @param recommendation Fila de la recomendación (ya verificada en su tenant).
 * @param plans Planes de ejecución de la recomendación.
 * @param decisions Decisiones humanas registradas sobre la recomendación.
 * @param executions Ejecuciones manuales de la recomendación.
 * @param learningEvents Eventos de aprendizaje del agente asociados.
 * @returns Eventos ordenados cronológicamente por `createdAt` ascendente.
 */
export function buildRecommendationTimeline(
  recommendation: RecommendationRow,
  plans: ExecutionPlanRows,
  decisions: DecisionRows,
  executions: ManualExecutionRows,
  learningEvents: LearningEventRows,
): RecommendationTimelineEvent[] {
  const events: RecommendationTimelineEvent[] = [
    {
      id: recommendation.id,
      type: 'RECOMMENDATION_CREATED',
      title: 'Recomendacion generada',
      description: recommendation.title,
      createdAt: recommendation.createdAt,
      metadata: toDomain(recommendation),
    },
    ...plans.map((plan): RecommendationTimelineEvent => ({
      id: plan.id,
      type: 'PLAN_GENERATED',
      title: 'Plan de ejecucion auditado',
      description: `Auditoria ${plan.auditVerdict} con score ${plan.auditScore}/100`,
      createdAt: plan.createdAt,
      metadata: toExecutionPlanDomain(plan),
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
      metadata: toManualExecutionDomain(execution),
    })),
    ...learningEvents.map((event): RecommendationTimelineEvent => ({
      id: event.id,
      type: 'LEARNING_EVENT',
      title: learningTimelineTitle(event.status),
      description: learningTimelineDescription(event.status, event.errorMessage),
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

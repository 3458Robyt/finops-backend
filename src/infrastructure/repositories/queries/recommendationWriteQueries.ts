import type {
  CreateManualExecutionInput,
  CreateRecommendationDecisionInput,
} from '../../../domain/interfaces/IRecommendationRepository.js';
import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Escrituras transaccionales del ciclo de vida de recomendaciones
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla las operaciones de escritura atómicas (decisión humana y ejecución
 * manual) del repositorio de recomendaciones. Cada operación se ejecuta dentro
 * de una transacción que valida invariantes de negocio (existencia en el
 * tenant, estado válido, correspondencia del plan) y sincroniza el estado de la
 * recomendación. Devuelven filas crudas de Prisma para que el repositorio las
 * mapee a dominio. Todas verifican `tenantId` (aislamiento multi-tenant).
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 *
 * @module infrastructure/repositories/queries/recommendationWriteQueries
 */

type RecommendationRow = Awaited<ReturnType<PrismaClient['recommendation']['update']>>;
type ManualExecutionRow = Awaited<ReturnType<PrismaClient['recommendationManualExecution']['create']>>;

/**
 * Registra una decisión humana (aprobar/rechazar/marcar como hecha) sobre una
 * recomendación y sincroniza su estado, de forma atómica.
 *
 * Dentro de una transacción: (1) verifica que la recomendación exista en el
 * tenant (aislamiento multi-tenant), lanzando error si no; (2) crea la decisión
 * con `learningStatus: 'PENDING'` (el aprendizaje del agente se procesa
 * después); y (3) actualiza el estado de la recomendación, mapeando
 * `MARKED_DONE` a `MANUAL_COMPLETED` y, en el resto de casos, usando el propio
 * valor de la decisión.
 *
 * @param prisma Cliente Prisma.
 * @param input Datos de la decisión (tenant, recomendación, usuario, decisión
 *   y motivo opcional).
 * @returns El id de la decisión creada y la fila cruda de la recomendación
 *   actualizada.
 * @throws Error si la recomendación no existe en el tenant.
 */
export async function createDecisionTx(
  prisma: PrismaClient,
  input: CreateRecommendationDecisionInput,
): Promise<{ readonly decisionId: string; readonly recommendation: RecommendationRow }> {
  return prisma.$transaction(async (tx) => {
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
}

/**
 * Registra una ejecución manual de una recomendación y, si procede, actualiza
 * su estado, de forma atómica.
 *
 * Dentro de una transacción valida invariantes de negocio: (1) la recomendación
 * debe existir en el tenant (aislamiento multi-tenant); (2) solo se pueden
 * ejecutar manualmente recomendaciones en estado `APPROVED` o
 * `MANUAL_COMPLETED`; (3) si se indica `executionPlanId`, este debe pertenecer
 * a la recomendación. Crea el registro de ejecución (importe observado en la
 * divisa `currency`, `evidence` como JSON) y, cuando el estado es `EXECUTED`,
 * marca la recomendación como `MANUAL_COMPLETED`.
 *
 * @param prisma Cliente Prisma.
 * @param input Datos de la ejecución manual.
 * @returns La fila cruda de la ejecución manual creada.
 * @throws Error si la recomendación no existe, no está en un estado válido o
 *   el plan de ejecución indicado no corresponde a la recomendación.
 */
export async function createManualExecutionTx(
  prisma: PrismaClient,
  input: CreateManualExecutionInput,
): Promise<ManualExecutionRow> {
  return prisma.$transaction(async (tx) => {
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
}

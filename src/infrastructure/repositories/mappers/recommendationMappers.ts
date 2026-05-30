/**
 * Mappers puros y helpers de presentación del repositorio de recomendaciones.
 *
 * Responsabilidad: aislar la traducción `fila Prisma` -> modelo de dominio de
 * las entidades del ciclo de vida de recomendaciones (recomendación, plan de
 * ejecución y ejecución manual), junto con los helpers puros de cálculo y
 * etiquetado de la línea de tiempo. Todas las funciones aquí son puras (no
 * dependen de `this` ni del cliente Prisma) para mantener el repositorio
 * enfocado en el acceso a datos.
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 */
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';
import type { RecommendationExecutionPlan } from '../../../domain/models/RecommendationExecutionPlan.js';
import type { RecommendationManualExecution } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

/**
 * Mapea una fila de `recommendations` (Prisma) al modelo de dominio
 * {@link FinOpsRecommendation}.
 *
 * Casos borde: `estimatedMonthlySavings` (`Decimal`) se convierte a `number`
 * con `Number()` y solo se incluye cuando no es `null`; el importe se expresa
 * en la divisa `currency`. El campo `evidence` se expone tal cual (JSON).
 *
 * @param row Fila de recomendación de Prisma.
 * @returns Recomendación de dominio.
 */
export function toDomain(row: Awaited<ReturnType<PrismaClient['recommendation']['findFirst']>> & {}): FinOpsRecommendation {
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

/**
 * Mapea una fila de `recommendation_execution_plans` (Prisma) al modelo de
 * dominio {@link RecommendationExecutionPlan}. Los campos `content` y
 * `auditReport` se exponen como JSON.
 *
 * @param row Fila del plan de ejecución de Prisma.
 * @returns Plan de ejecución de dominio.
 */
export function toExecutionPlanDomain(row: Awaited<ReturnType<PrismaClient['recommendationExecutionPlan']['findFirst']>> & {}): RecommendationExecutionPlan {
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

/**
 * Mapea una fila de `recommendation_manual_executions` (Prisma) al modelo de
 * dominio {@link RecommendationManualExecution}.
 *
 * Casos borde: `observedMonthlySavings` (`Decimal`) se convierte a `number`
 * (en la divisa `currency`) y, junto con los demás campos anulables
 * (`executionPlanId`, `executedAt`, `notes`, `evidence`), solo se incluye
 * cuando no es `null`.
 *
 * @param row Fila de ejecución manual de Prisma.
 * @returns Ejecución manual de dominio.
 */
export function toManualExecutionDomain(
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

/**
 * Devuelve el título legible (en español) del evento de aprendizaje según su
 * estado, para mostrarlo en la línea de tiempo.
 *
 * @param status Estado del evento de aprendizaje.
 * @returns Título correspondiente, con un valor genérico de respaldo si el
 *   estado no está mapeado.
 */
export function learningTimelineTitle(status: string): string {
  const titles: Record<string, string> = {
    PENDING: 'Aprendizaje en cola',
    APPROVED: 'Aprendizaje registrado',
    REJECTED: 'Memoria descartada por auditor',
    SKIPPED: 'Aprendizaje omitido temporalmente',
    ERROR: 'Error interno de aprendizaje',
  };

  return titles[status] ?? 'Aprendizaje del agente';
}

/**
 * Devuelve la descripción legible (en español) del evento de aprendizaje según
 * su estado, para la línea de tiempo.
 *
 * Caso especial: si el estado es `ERROR` y hay un `errorMessage` no vacío, lo
 * anexa a la descripción base para aportar detalle del fallo.
 *
 * @param status Estado del evento de aprendizaje.
 * @param errorMessage Mensaje de error asociado (o `null` si no aplica).
 * @returns Descripción correspondiente, con un valor genérico de respaldo si
 *   el estado no está mapeado.
 */
export function learningTimelineDescription(status: string, errorMessage: string | null): string {
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

/**
 * Estima el ahorro perdido por no haber ejecutado una recomendación.
 *
 * Prorratea el ahorro mensual estimado a una tasa diaria
 * (`estimatedMonthlySavings / 30`) y la multiplica por los días transcurridos
 * desde `createdAt` (acotados a un mínimo de 0). El resultado se redondea a 2
 * decimales (ver {@link roundCurrency}).
 *
 * @param estimatedMonthlySavings Ahorro mensual estimado de la recomendación.
 * @param createdAt Fecha de creación de la recomendación.
 * @returns Importe estimado de ahorro perdido, redondeado a 2 decimales.
 */
export function calculateMissedSavings(estimatedMonthlySavings: number, createdAt: Date): number {
  const elapsedDays = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / (24 * 60 * 60 * 1000)));
  return roundCurrency((estimatedMonthlySavings / 30) * elapsedDays);
}

/**
 * Redondea un importe monetario a 2 decimales (precisión de céntimos),
 * evitando errores de coma flotante acumulados en las sumas de ahorro.
 *
 * @param value Importe a redondear.
 * @returns Importe redondeado a 2 decimales.
 */
export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Veredicto de la auditoría de IA sobre un plan de ejecución.
 *
 * - `APPROVED`: El plan se considera válido y aprobado.
 * - `REJECTED`: El plan se rechaza.
 * - `NEEDS_REVISION`: El plan requiere cambios antes de poder aprobarse.
 */
export type AiAuditVerdict = 'APPROVED' | 'REJECTED' | 'NEEDS_REVISION';

/**
 * Resultado de un control individual realizado durante la auditoría de IA de
 * un plan de ejecución.
 */
export interface AiAuditCheck {
  /** Nombre del control auditado. */
  readonly name: string;
  /** `true` si el control se superó. */
  readonly passed: boolean;
  /** Observaciones o justificación del resultado del control. */
  readonly notes: string;
}

/**
 * Informe de auditoría de IA que evalúa la calidad y seguridad de un plan de
 * ejecución antes de su aprobación.
 */
export interface AiAuditReport {
  /** Veredicto global de la auditoría. */
  readonly verdict: AiAuditVerdict;
  /** Puntuación global de calidad del plan (escala definida por el auditor). */
  readonly score: number;
  /** Detalle de los controles individuales evaluados. */
  readonly checks: readonly AiAuditCheck[];
  /** Problemas bloqueantes que impiden la aprobación del plan. */
  readonly blockingIssues: readonly string[];
  /** Cambios requeridos para que el plan pueda aprobarse. */
  readonly requiredChanges: readonly string[];
}

/**
 * Plan de ejecución generado por IA para llevar a cabo una recomendación
 * FinOps, incluyendo su contenido y el resultado de la auditoría automática.
 */
export interface RecommendationExecutionPlan {
  /** Identificador único del plan de ejecución. */
  readonly id: string;
  /** Recomendación que el plan pretende ejecutar. */
  readonly recommendationId: string;
  /** Usuario que solicitó/generó el plan. */
  readonly generatedByUserId: string;
  /** Identificador del modelo de IA que generó el plan. */
  readonly model: string;
  /** Identificador del modelo de IA que auditó el plan. */
  readonly auditorModel: string;
  /** Contenido del plan de ejecución (estructura libre). */
  readonly content: unknown;
  /** Informe de auditoría completo (estructura libre; ver {@link AiAuditReport}). */
  readonly auditReport: unknown;
  /** Veredicto resultante de la auditoría. */
  readonly auditVerdict: AiAuditVerdict;
  /** Puntuación resultante de la auditoría. */
  readonly auditScore: number;
  /** Fecha de creación del plan. */
  readonly createdAt: Date;
}

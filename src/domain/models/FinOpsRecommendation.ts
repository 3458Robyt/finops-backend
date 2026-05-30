/**
 * Recomendación FinOps de optimización de costos generada para una cuenta cloud.
 * Representa una oportunidad de ahorro o mejora detectada, junto con su evidencia
 * y estado de gestión dentro del flujo de aprobación.
 */
export interface FinOpsRecommendation {
  /** Identificador único de la recomendación. */
  readonly id: string;
  /** Cuenta cloud a la que aplica la recomendación. */
  readonly cloudAccountId: string;
  /** Tipo de recomendación (e.g., rightsizing, eliminación de recursos ociosos). */
  readonly type: string;
  /**
   * Estado de gestión de la recomendación.
   *
   * - `PENDING`: Pendiente de revisión/decisión.
   * - `APPROVED`: Aprobada para su ejecución.
   * - `REJECTED`: Rechazada.
   * - `MANUAL_COMPLETED`: Resuelta manualmente fuera del flujo automático.
   */
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MANUAL_COMPLETED';
  /**
   * Severidad/impacto de la recomendación.
   *
   * - `LOW`: Impacto bajo.
   * - `MEDIUM`: Impacto medio.
   * - `HIGH`: Impacto alto.
   * - `CRITICAL`: Impacto crítico.
   */
  readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Título resumido de la recomendación. */
  readonly title: string;
  /** Descripción detallada de la recomendación. */
  readonly description: string;
  /** Evidencia de soporte que justifica la recomendación (estructura libre). */
  readonly evidence: unknown;
  /** Ahorro mensual estimado, expresado en la divisa de {@link currency}. */
  readonly estimatedMonthlySavings?: number;
  /** Divisa del ahorro estimado, en formato ISO 4217 de 3 letras (e.g., "USD"). */
  readonly currency: string;
  /** Fecha de creación del registro. */
  readonly createdAt: Date;
  /** Fecha de la última actualización del registro. */
  readonly updatedAt: Date;
}

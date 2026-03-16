/**
 * ═══════════════════════════════════════════════════════════════
 * InternalCostMetric — Modelo de Dominio Core
 * ═══════════════════════════════════════════════════════════════
 *
 * Representación canónica e independiente de proveedor para una
 * métrica de costo en la nube. Todos los adaptadores de nube DEBEN
 * mapear sus datos brutos a esta estructura antes de ser procesados
 * por la capa de aplicación.
 *
 * @module domain/models
 */

/**
 * Métrica de costo interna estandarizada.
 *
 * Este contrato actúa como la "lingua franca" del sistema,
 * desacoplando la lógica de negocio de las APIs específicas
 * de cada proveedor de nube.
 */
export interface InternalCostMetric {
  /** Identificador único del recurso cloud (e.g., ARN en AWS, OCID en OCI). */
  readonly resourceId: string;

  /** Nombre del servicio cloud (e.g., "Amazon EC2", "OCI Compute"). */
  readonly service: string;

  /**
   * Cantidad facturada en la divisa.
   * Ej: 15.50
   */
  readonly amount: number;

  /**
   * Divisa (Moneda) en formato ISO 4217 de 3 letras.
   * Ej: "USD", "EUR", "COP".
   */
  readonly currency: string;

  /**
   * Cantidad de uso consumido (opcional).
   * Ej: 500.5
   */
  readonly usage?: number;

  /**
   * Unidad de medida del uso (opcional).
   * Ej: "GB", "Hrs", "Bytes"
   */
  readonly usageUnit?: string;

  /**
   * Fecha y hora a la que corresponde la métrica.
   * Generalmente representa el inicio del día (00:00:00 UTC) para métricas diarias.
   */
  readonly timestamp: Date;

  /** Etiquetas/tags del recurso para categorización y análisis. */
  readonly tags: Readonly<Record<string, string>>;
}

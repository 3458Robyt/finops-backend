/**
 * ═══════════════════════════════════════════════════════════════
 * ICostRepository — Contrato de Persistencia
 * ═══════════════════════════════════════════════════════════════
 *
 * Define el contrato para la capa de persistencia de métricas
 * de costo. Preparado para PostgreSQL + TimescaleDB.
 *
 * @module domain/interfaces
 */

import type { InternalCostMetric } from '../models/InternalCostMetric.js';

/**
 * Contexto de tenant/cuenta para un lote de métricas de costo.
 *
 * Aporta los datos de propiedad y trazabilidad que no provienen del proveedor
 * cloud y que deben asociarse a cada métrica al persistirla.
 */
export interface CostMetricBatchContext {
  /** Tenant propietario de las métricas; clave del aislamiento multi-tenant. */
  readonly tenantId: string;
  /** Cuenta cloud a la que pertenecen las métricas. */
  readonly cloudAccountId: string;
  /** Nombre del proveedor de origen (e.g., "aws", "oci"). */
  readonly providerName: string;
  /** Identificador de la ejecución de ingesta que originó el lote; opcional, usado para trazabilidad. */
  readonly ingestionRunId?: string;
}

/**
 * Criterios de consulta de métricas de costo por rango temporal.
 */
export interface CostMetricQuery {
  readonly tenantId: string;
  /** Filtra por proveedor; opcional. */
  readonly providerName?: string;
  /** Filtra por cuenta cloud; opcional. */
  readonly cloudAccountId?: string;
  /** Inicio del rango temporal a consultar (inclusivo). */
  readonly startDate: Date;
  /** Fin del rango temporal a consultar. */
  readonly endDate: Date;
}

/**
 * Contrato de repositorio para persistencia de métricas de costo.
 *
 * Siguiendo el principio DIP, las capas de aplicación dependen
 * de esta abstracción, no de la implementación concreta de PostgreSQL.
 */
export interface ICostRepository {
  /**
   * Inserta un lote de métricas de costo en la base de datos.
   *
   * @param context - Contexto tenant/cuenta que no viene de los proveedores cloud.
   * @param metrics - Arreglo de métricas normalizadas a persistir.
   * @returns       - Cantidad de registros insertados exitosamente.
   */
  insertBatch(
    context: CostMetricBatchContext,
    metrics: readonly InternalCostMetric[],
  ): Promise<number>;

  /**
   * Consulta métricas de costo por rango de fechas y proveedor.
   *
   * @param query - Alcance tenant/cuenta/proveedor y rango temporal.
   * @returns            - Arreglo de métricas dentro del rango.
   */
  findByDateRange(query: CostMetricQuery): Promise<InternalCostMetric[]>;
}

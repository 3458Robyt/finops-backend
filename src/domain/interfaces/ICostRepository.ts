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

export interface CostMetricBatchContext {
  readonly tenantId: string;
  readonly cloudAccountId: string;
  readonly providerName: string;
  readonly ingestionRunId?: string;
}

export interface CostMetricQuery {
  readonly tenantId: string;
  readonly providerName?: string;
  readonly cloudAccountId?: string;
  readonly startDate: Date;
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

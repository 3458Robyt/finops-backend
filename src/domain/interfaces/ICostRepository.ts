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
 * Contrato de repositorio para persistencia de métricas de costo.
 *
 * Siguiendo el principio DIP, las capas de aplicación dependen
 * de esta abstracción, no de la implementación concreta de PostgreSQL.
 */
export interface ICostRepository {
  /**
   * Inserta un lote de métricas de costo en la base de datos.
   *
   * @param metrics - Arreglo de métricas normalizadas a persistir.
   * @returns       - Cantidad de registros insertados exitosamente.
   */
  insertBatch(metrics: readonly InternalCostMetric[]): Promise<number>;

  /**
   * Consulta métricas de costo por rango de fechas y proveedor.
   *
   * @param providerName - Nombre del proveedor cloud.
   * @param startDate    - Inicio del rango (inclusive).
   * @param endDate      - Fin del rango (inclusive).
   * @returns            - Arreglo de métricas dentro del rango.
   */
  findByDateRange(
    providerName: string,
    startDate: Date,
    endDate: Date,
  ): Promise<InternalCostMetric[]>;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * ICloudProvider — Contrato del Adaptador de Nube
 * ═══════════════════════════════════════════════════════════════
 *
 * Define el contrato que TODOS los proveedores de nube deben
 * implementar (Adapter Pattern). Garantiza interoperabilidad
 * multicloud sin acoplar la lógica de negocio a APIs específicas.
 *
 * Principios SOLID aplicados:
 *   - ISP: Interfaz cohesiva y enfocada en una sola responsabilidad.
 *   - DIP: Las capas superiores dependen de esta abstracción, no de implementaciones.
 *   - OCP: Nuevos proveedores se agregan sin modificar código existente.
 *
 * @module domain/interfaces
 */

import type { InternalCostMetric } from '../models/InternalCostMetric.js';

/**
 * Contrato estricto para adaptadores de proveedores de nube.
 *
 * Cada proveedor (AWS, OCI, Azure, GCP…) implementa esta interfaz
 * para normalizar la extracción de datos de facturación al formato
 * canónico {@link InternalCostMetric}.
 */
export interface ICloudProvider {
  /** Nombre identificador del proveedor (e.g., "aws", "oci"). */
  readonly providerName: string;

  /**
   * Obtiene los costos diarios de una cuenta cloud para una fecha específica.
   *
   * @param accountId - Identificador de la cuenta en el proveedor (e.g., AWS Account ID, OCI Tenancy OCID).
   * @param date      - Fecha del día a consultar.
   * @returns         - Arreglo de métricas de costo normalizadas.
   * @throws {ProviderError} Si la conexión o transformación de datos falla.
   */
  fetchDailyCosts(accountId: string, date: Date): Promise<InternalCostMetric[]>;
}

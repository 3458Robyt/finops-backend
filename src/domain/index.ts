/**
 * ═══════════════════════════════════════════════════════════════
 * Domain Layer — Barrel Export
 * ═══════════════════════════════════════════════════════════════
 *
 * Punto de entrada público de la capa de dominio. Reexporta los modelos,
 * interfaces (puertos) y errores que el resto de la aplicación consume,
 * manteniendo el dominio desacoplado de las capas externas.
 */

/** Métrica de costo canónica del dominio. */
export { type InternalCostMetric } from './models/index.js';
/** Puertos del dominio: proveedor cloud y repositorio de costos. */
export { type ICloudProvider, type ICostRepository } from './interfaces/index.js';
/** Jerarquía de errores del dominio. */
export {
  FinOpsBaseError,
  ProviderError,
  ProviderNotFoundError,
  IngestionError,
} from './errors/index.js';

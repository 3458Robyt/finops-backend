import type { ProviderCatalogEntry } from '../models/CloudConnection.js';

/**
 * Datos de entrada para aprovisionar el acceso operativo de una conexión cloud
 * usando una credencial administrativa temporal.
 *
 * El flujo emplea una credencial de administrador de corta duración para crear
 * un principal operativo de menor privilegio que será el utilizado de forma permanente.
 */
export interface TemporaryAdminProvisioningInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  /** Credencial administrativa temporal específica del proveedor; su forma varía por plugin (claves, OCID, etc.). */
  readonly temporaryAdminCredential: Readonly<Record<string, unknown>>;
}

/**
 * Resultado del aprovisionamiento con credencial administrativa temporal.
 */
export interface TemporaryAdminProvisioningResult {
  /** Identificador del principal operativo creado (rol/usuario de servicio de menor privilegio). */
  readonly operationalPrincipalId: string;
  /** Identificador externo del export de facturación configurado; presente si aplica. */
  readonly exportExternalId?: string;
  /** Ruta del export de facturación (e.g., bucket/prefijo); presente si aplica. */
  readonly exportPath?: string;
  /** Referencia a la ubicación de almacenamiento asociada al export; presente si aplica. */
  readonly storageLocationRef?: string;
  /** Mensajes informativos o advertencias generados durante el aprovisionamiento. */
  readonly messages: readonly string[];
}

/**
 * Contrato de un plugin de proveedor de nube.
 *
 * Aplica el patrón Plugin/Strategy para encapsular la lógica específica de cada
 * proveedor (AWS, OCI, Azure, GCP…) en torno al aprovisionamiento y validación de
 * accesos. Es un puerto de dominio cuya implementación concreta reside en la capa
 * de infraestructura, permitiendo añadir proveedores sin modificar el núcleo (OCP).
 */
export interface CloudProviderPlugin {
  /** Entrada de catálogo que describe el proveedor soportado por este plugin. */
  readonly catalog: ProviderCatalogEntry;

  /**
   * Aprovisiona el acceso operativo permanente a partir de una credencial administrativa temporal.
   *
   * @param input - Tenant, conexión y credencial administrativa temporal.
   * @returns Detalles del principal operativo creado y de la configuración de export.
   */
  provisionWithTemporaryAdmin(
    input: TemporaryAdminProvisioningInput,
  ): Promise<TemporaryAdminProvisioningResult>;

  /**
   * Valida que el acceso operativo de una conexión cloud sea funcional.
   *
   * @param cloudConnectionId - Identificador de la conexión cloud a validar.
   * @returns Lista de mensajes de diagnóstico; vacía si la validación es completamente satisfactoria.
   */
  validateOperationalAccess(cloudConnectionId: string): Promise<readonly string[]>;
}

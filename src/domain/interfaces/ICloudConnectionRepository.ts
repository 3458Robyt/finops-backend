import type {
  CloudConnectionSummary,
  IngestionHealthSummary,
  IngestionSourceType,
  ProviderCatalogEntry,
  ProviderCode,
} from '../models/CloudConnection.js';

/**
 * Datos de entrada para crear una conexión cloud de un tenant.
 *
 * Representa el vínculo entre un tenant y una cuenta raíz de un proveedor cloud.
 */
export interface CreateCloudConnectionInput {
  readonly tenantId: string;
  /** Código del proveedor cloud (e.g., AWS, OCI) al que pertenece la conexión. */
  readonly providerCode: ProviderCode;
  /** Identificador externo de la cuenta/organización raíz en el proveedor. */
  readonly rootExternalId: string;
  /** Nombre legible asignado a la conexión. */
  readonly name: string;
  /** Región por defecto usada para operaciones que la requieran; opcional. */
  readonly defaultRegion?: string;
  /** Metadatos arbitrarios específicos del proveedor; opcional. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Datos de entrada para encolar un trabajo de ingesta de costos.
 *
 * Define el rango temporal objetivo y el origen de los datos a importar.
 */
export interface CreateIngestionJobInput {
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  /** Tipo de fuente de ingesta (e.g., export de facturación, API). */
  readonly sourceType: IngestionSourceType;
  /** Usuario que solicitó la ingesta; opcional cuando es disparada por el sistema. */
  readonly requestedByUserId?: string;
  /** Inicio del rango temporal a ingerir (inclusivo). */
  readonly targetStart: Date;
  /** Fin del rango temporal a ingerir. */
  readonly targetEnd: Date;
  /** Número máximo de intentos antes de marcar el trabajo como fallido; opcional. */
  readonly maxAttempts?: number;
}

/**
 * Resumen del estado de un trabajo de ingesta.
 */
export interface IngestionJobSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudConnectionId: string;
  readonly sourceType: IngestionSourceType;
  /** Estado actual del ciclo de vida del trabajo de ingesta. */
  readonly status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  readonly targetStart: Date;
  readonly targetEnd: Date;
  /** Cantidad de intentos ya ejecutados. */
  readonly attempts: number;
  /** Cantidad máxima de intentos permitidos. */
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Contrato de repositorio para conexiones cloud y trabajos de ingesta.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en la capa de
 * infraestructura. Gestiona el catálogo de proveedores, las conexiones de cada
 * tenant y la programación/seguimiento de la ingesta de datos de costo.
 */
export interface ICloudConnectionRepository {
  /**
   * Lista todas las entradas del catálogo de proveedores soportados.
   *
   * @returns Catálogo de proveedores disponibles.
   */
  listProviderCatalog(): Promise<readonly ProviderCatalogEntry[]>;

  /**
   * Busca una entrada del catálogo por su código de proveedor.
   *
   * @param providerCode - Código del proveedor a localizar.
   * @returns La entrada del catálogo si existe; `null` si el proveedor no está soportado.
   */
  findProviderCatalog(providerCode: string): Promise<ProviderCatalogEntry | null>;

  /**
   * Crea una nueva conexión cloud para un tenant.
   *
   * @param input - Datos del tenant, proveedor y cuenta raíz.
   * @returns Resumen de la conexión recién creada.
   */
  createCloudConnection(input: CreateCloudConnectionInput): Promise<CloudConnectionSummary>;

  /**
   * Busca una conexión cloud concreta perteneciente a un tenant.
   *
   * @param tenantId          - Tenant propietario de la conexión.
   * @param cloudConnectionId - Identificador de la conexión.
   * @returns Resumen de la conexión si pertenece al tenant; `null` si no existe o no le pertenece.
   */
  findCloudConnectionForTenant(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<CloudConnectionSummary | null>;

  /**
   * Lista las conexiones cloud asociadas a un tenant.
   *
   * @param tenantId - Tenant cuyas conexiones se desean listar.
   * @returns Conexiones del tenant (posiblemente vacío).
   */
  listCloudConnectionsForTenant(tenantId: string): Promise<readonly CloudConnectionSummary[]>;

  /**
   * Marca una conexión cloud como validada en un instante dado.
   *
   * @param cloudConnectionId - Identificador de la conexión validada.
   * @param validatedAt       - Instante en que se completó la validación.
   */
  markCloudConnectionValidated(cloudConnectionId: string, validatedAt: Date): Promise<void>;

  /**
   * Crea y encola un trabajo de ingesta de costos.
   *
   * @param input - Conexión, origen y rango temporal a ingerir.
   * @returns Resumen del trabajo de ingesta creado.
   */
  createIngestionJob(input: CreateIngestionJobInput): Promise<IngestionJobSummary>;

  /**
   * Obtiene un resumen de salud de la ingesta para una conexión cloud.
   *
   * @param tenantId          - Tenant propietario de la conexión.
   * @param cloudConnectionId - Identificador de la conexión.
   * @returns Resumen de salud de ingesta; `null` si no hay datos disponibles para la conexión.
   */
  getIngestionHealth(
    tenantId: string,
    cloudConnectionId: string,
  ): Promise<IngestionHealthSummary | null>;
}

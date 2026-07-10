/**
 * Código identificador del proveedor cloud. Se aceptan los valores conocidos
 * (`aws`, `oci`, `azure`, `gcp`) y cualquier otro `string` para soportar
 * proveedores personalizados.
 */
export type ProviderCode = 'aws' | 'oci' | 'azure' | 'gcp' | string;

/**
 * Estado de una conexión cloud.
 *
 * - `ACTIVE`: Conexión habilitada; se ingestan y procesan sus datos.
 * - `DISABLED`: Conexión deshabilitada; se omite en la ingesta.
 */
export type CloudConnectionStatus = 'ACTIVE' | 'DISABLED';

/**
 * Tipo de fuente de datos que se ingesta desde el proveedor cloud.
 *
 * - `BILLING_EXPORT`: Exportación de facturación/costos.
 * - `INVENTORY`: Inventario de recursos.
 * - `TECHNICAL_METRIC`: Métricas técnicas (uso, rendimiento).
 * - `AGENT_METRIC`: Métricas recolectadas por un agente.
 */
export type IngestionSourceType =
  | 'BILLING_EXPORT'
  | 'INVENTORY'
  | 'TECHNICAL_METRIC'
  | 'AGENT_METRIC';

/**
 * Estado de un trabajo (job) de ingesta de datos.
 *
 * - `PENDING`: Encolado, pendiente de iniciar.
 * - `RUNNING`: En ejecución.
 * - `SUCCESS`: Finalizado correctamente.
 * - `FAILED`: Finalizado con error.
 * - `CANCELLED`: Cancelado antes de completarse.
 */
export type IngestionJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED';

/**
 * Resultado de un control de calidad de datos.
 *
 * - `PASSED`: El control se superó sin incidencias.
 * - `WARNING`: El control detectó anomalías no bloqueantes.
 * - `FAILED`: El control falló.
 */
export type DataQualityStatus = 'PASSED' | 'WARNING' | 'FAILED';

/**
 * Entrada del catálogo de proveedores soportados, que describe las capacidades
 * y configuración por defecto de un proveedor cloud disponible en la plataforma.
 */
export interface ProviderCatalogEntry {
  /** Código identificador del proveedor. */
  readonly code: ProviderCode;
  /** Nombre legible para mostrar en la interfaz. */
  readonly displayName: string;
  /** Familia del proveedor; `CUSTOM` para integraciones a medida. */
  readonly provider: 'AWS' | 'OCI' | 'AZURE' | 'GCP' | 'CUSTOM';
  /** Capacidades soportadas por el proveedor (e.g., tipos de ingesta disponibles). */
  readonly capabilities: readonly string[];
  /** Versión de FOCUS (FinOps Open Cost & Usage Specification) usada por defecto, si aplica. */
  readonly defaultFocusVersion?: string;
  /** URL de la documentación del proveedor. */
  readonly documentationUrl?: string;
  /** `true` si el proveedor está habilitado para su uso. */
  readonly enabled: boolean;
}

/**
 * Resumen de una conexión cloud configurada por un tenant, con su estado y
 * metadatos básicos. Representa el vínculo entre la plataforma y una cuenta
 * del proveedor.
 */
export interface CloudConnectionSummary {
  /** Identificador único de la conexión. */
  readonly id: string;
  /** Tenant (cliente) propietario de la conexión. */
  readonly tenantId: string;
  /** Código del proveedor cloud asociado. */
  readonly providerCode: ProviderCode;
  /** Identificador externo raíz de la cuenta en el proveedor (e.g., account ID, tenancy OCID). */
  readonly rootExternalId: string;
  /** Nombre descriptivo de la conexión. */
  readonly name: string;
  /** Estado de la conexión. */
  readonly status: CloudConnectionStatus;
  /** Región por defecto utilizada para las operaciones, si se define. */
  readonly defaultRegion?: string;
  /** Metadatos adicionales de la conexión (estructura libre, solo lectura). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Fecha de la última validación correcta de las credenciales/conexión. */
  readonly lastValidatedAt?: Date;
  /** Fecha de creación del registro. */
  readonly createdAt: Date;
  /** Fecha de la última actualización del registro. */
  readonly updatedAt: Date;
}

/**
 * Resumen del estado de salud de la ingesta de una conexión cloud: agrega el
 * estado de los trabajos, las marcas de agua (watermarks) por fuente y los
 * controles de calidad recientes. Se usa en paneles de observabilidad de la ingesta.
 */
export interface IngestionHealthSummary {
  /** Conexión cloud a la que corresponde el resumen. */
  readonly cloudConnection: CloudConnectionSummary;
  /** Entrada de catálogo del proveedor de la conexión. */
  readonly provider: ProviderCatalogEntry;
  /** Conteo de trabajos de ingesta por estado relevante. */
  readonly jobs: {
    /** Número de trabajos pendientes. */
    readonly pending: number;
    /** Número de trabajos en ejecución. */
    readonly running: number;
    /** Número de trabajos fallidos. */
    readonly failed: number;
  };
  /**
   * Marcas de agua de ingesta por tipo de fuente, que indican hasta qué punto
   * se han ingestado los datos y los plazos de frescura.
   */
  readonly watermarks: readonly {
    /** Tipo de fuente al que corresponde la marca de agua. */
    readonly sourceType: IngestionSourceType;
    /** Inicio del rango temporal ingestado. */
    readonly watermarkStart?: Date;
    /** Fin del rango temporal ingestado. */
    readonly watermarkEnd?: Date;
    /** Fecha de la última ejecución exitosa para esta fuente. */
    readonly lastSuccessfulRunAt?: Date;
    /** Fecha límite para que los datos se consideren "frescos". */
    readonly freshnessDeadlineAt?: Date;
  }[];
  /** Resultados de los controles de calidad de datos por tipo de fuente. */
  readonly qualityChecks: readonly {
    /** Tipo de fuente sobre el que se ejecutó el control. */
    readonly sourceType: IngestionSourceType;
    /** Nombre del control de calidad. */
    readonly checkName: string;
    /** Resultado del control. */
    readonly status: DataQualityStatus;
    /** Fecha en la que se observó/ejecutó el control. */
    readonly observedAt: Date;
    /** Fecha en la que se esperaba el dato, si aplica (para controles de frescura). */
    readonly expectedAt?: Date;
    /** Detalles adicionales del control (estructura libre, solo lectura). */
    readonly details?: Readonly<Record<string, unknown>>;
  }[];
}

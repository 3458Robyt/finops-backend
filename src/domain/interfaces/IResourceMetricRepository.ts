/**
 * Estado del ciclo de vida de un recurso cloud inventariado.
 *
 * Refleja el enum `CloudResourceStatus` de Prisma (`ACTIVE`, `STOPPED`,
 * `TERMINATED`, `UNKNOWN`).
 */
export type CloudResourceStatus = 'ACTIVE' | 'STOPPED' | 'TERMINATED' | 'UNKNOWN';

/**
 * Resumen de un recurso cloud inventariado de un tenant.
 *
 * Proyección de solo lectura de `cloud_resources`. Representa la identidad
 * técnica del recurso (no su costo): tipo, servicio, región y estado.
 */
export interface CloudResourceItem {
  readonly id: string;
  readonly provider: string;
  readonly externalResourceId: string;
  readonly name?: string;
  readonly resourceType: string;
  readonly serviceName: string;
  readonly regionId?: string;
  readonly status: CloudResourceStatus;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

/**
 * Muestra de una métrica técnica de un recurso cloud.
 *
 * Proyección de solo lectura de `resource_metric_samples`. Representa una
 * observación técnica real (CPU, memoria, IOPS, throughput, utilización, etc.)
 * recolectada de fuentes de monitorización/agentes. NO proviene de FOCUS: FOCUS
 * solo aporta costo y consumo facturado, nunca estas métricas técnicas.
 */
export interface ResourceMetricSampleItem {
  readonly id: string;
  readonly externalResourceId: string;
  /** Nombre de la métrica técnica (p. ej. `cpu_utilization`, `memory_used`). */
  readonly metricName: string;
  /** Unidad de la métrica (p. ej. `Percent`, `Bytes`, `IOPS`), si se conoce. */
  readonly metricUnit?: string;
  /** Valor observado de la métrica. */
  readonly value: number;
  /** Instante de la observación. */
  readonly sampledAt: Date;
  /** Granularidad de la muestra en segundos. */
  readonly granularitySeconds: number;
}

/**
 * Contrato de repositorio para métricas técnicas de recursos cloud.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en infraestructura.
 * Expone el inventario de recursos y sus muestras de métricas técnicas, de forma
 * estrictamente separada del consumo facturado de FOCUS. Las operaciones filtran
 * por `tenantId` (aislamiento multi-tenant).
 */
export interface IResourceMetricRepository {
  /**
   * Lista los recursos cloud inventariados de un tenant, del visto más
   * recientemente al más antiguo.
   *
   * @param tenantId - Tenant cuyos recursos se consultan (aislamiento multi-tenant).
   * @param limit    - Número máximo de recursos a devolver.
   * @returns Recursos cloud del tenant (posiblemente vacío).
   */
  listResourcesForTenant(tenantId: string, limit: number): Promise<readonly CloudResourceItem[]>;

  /**
   * Lista las muestras de métricas técnicas de un tenant, de la más reciente a
   * la más antigua.
   *
   * @param tenantId - Tenant cuyas muestras se consultan (aislamiento multi-tenant).
   * @param limit    - Número máximo de muestras a devolver.
   * @returns Muestras de métricas técnicas del tenant (posiblemente vacío).
   */
  listMetricSamplesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly ResourceMetricSampleItem[]>;
}

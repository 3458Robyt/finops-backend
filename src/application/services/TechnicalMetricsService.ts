import type {
  CloudResourceItem,
  IResourceMetricRepository,
  ResourceMetricSampleItem,
} from '../../domain/interfaces/IResourceMetricRepository.js';

/**
 * Servicio de aplicación de métricas técnicas de recursos cloud.
 *
 * Responsabilidad: exponer el inventario de recursos y sus muestras de métricas
 * técnicas (CPU, memoria, IOPS, throughput, utilización), de forma estrictamente
 * separada del consumo facturado de FOCUS. Acota el límite de resultados y
 * delega el acceso a datos en {@link IResourceMetricRepository}.
 *
 * Nota de dominio: estas métricas provienen de fuentes de monitorización/agentes,
 * no de FOCUS. El sistema no infiere CPU/memoria/IOPS a partir de datos FOCUS.
 */
export class TechnicalMetricsService {
  constructor(private readonly repository: IResourceMetricRepository) {}

  /**
   * Lista los recursos cloud inventariados del tenant. El `limit` se acota al
   * rango [1, 200] con un valor por defecto de 50.
   */
  public listResources(tenantId: string, limit?: number): Promise<readonly CloudResourceItem[]> {
    return this.repository.listResourcesForTenant(tenantId, this.clampLimit(limit));
  }

  /**
   * Lista las muestras de métricas técnicas del tenant. El `limit` se acota al
   * rango [1, 200] con un valor por defecto de 50.
   */
  public listMetricSamples(
    tenantId: string,
    limit?: number,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    return this.repository.listMetricSamplesForTenant(tenantId, this.clampLimit(limit));
  }

  /**
   * Normaliza y acota el límite de resultados al rango [1, 200]. Valores no
   * finitos o ausentes usan el valor por defecto (50); los decimales se truncan.
   */
  private clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) {
      return 50;
    }

    return Math.min(200, Math.max(1, Math.floor(limit)));
  }
}

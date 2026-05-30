import type {
  CloudResourceItem,
  IResourceMetricRepository,
  ResourceMetricSampleItem,
} from '../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import {
  toCloudResourceItem,
  toResourceMetricSampleItem,
} from './mappers/technicalMetricsMappers.js';

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link IResourceMetricRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: leer el inventario de recursos cloud (`cloud_resources`) y
 * sus muestras de métricas técnicas (`resource_metric_samples`), de forma
 * estrictamente separada del consumo facturado de FOCUS. Todas las consultas
 * filtran por `tenantId` para garantizar el aislamiento multi-tenant.
 */
export class PrismaResourceMetricRepository implements IResourceMetricRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Lista los recursos cloud inventariados de un tenant, del visto más
   * recientemente al más antiguo, acotado a `limit`.
   *
   * @param tenantId Tenant cuyos recursos se consultan (aislamiento multi-tenant).
   * @param limit Número máximo de recursos a devolver.
   * @returns Recursos cloud de dominio; arreglo vacío si no hay.
   */
  public async listResourcesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly CloudResourceItem[]> {
    const resources = await this.prisma.cloudResource.findMany({
      where: { tenantId },
      orderBy: { lastSeenAt: 'desc' },
      take: limit,
    });

    return resources.map((resource) => toCloudResourceItem(resource));
  }

  /**
   * Lista las muestras de métricas técnicas de un tenant, de la más reciente a
   * la más antigua, acotado a `limit`.
   *
   * @param tenantId Tenant cuyas muestras se consultan (aislamiento multi-tenant).
   * @param limit Número máximo de muestras a devolver.
   * @returns Muestras de métricas técnicas de dominio; arreglo vacío si no hay.
   */
  public async listMetricSamplesForTenant(
    tenantId: string,
    limit: number,
  ): Promise<readonly ResourceMetricSampleItem[]> {
    const samples = await this.prisma.resourceMetricSample.findMany({
      where: { tenantId },
      orderBy: { sampledAt: 'desc' },
      take: limit,
    });

    return samples.map((sample) => toResourceMetricSampleItem(sample));
  }
}

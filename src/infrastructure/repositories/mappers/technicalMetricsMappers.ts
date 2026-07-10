/**
 * Mappers puros del repositorio de métricas técnicas.
 *
 * Responsabilidad: aislar la traducción `fila Prisma` -> modelo de dominio de
 * los recursos cloud (`cloud_resources`) y las muestras de métricas técnicas
 * (`resource_metric_samples`). Los importes `Decimal` se convierten a `number`;
 * los campos anulables solo se incluyen cuando no son `null`.
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 */
import type {
  CloudResourceItem,
  ResourceMetricSampleItem,
} from '../../../domain/interfaces/IResourceMetricRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

type PrismaCloudResource = Awaited<ReturnType<PrismaClient['cloudResource']['findUnique']>>;
type PrismaResourceMetricSample = Awaited<ReturnType<PrismaClient['resourceMetricSample']['findUnique']>>;

/**
 * Mapea una fila de `cloud_resources` al modelo de dominio
 * {@link CloudResourceItem}.
 *
 * Casos borde: `name` y `regionId` solo se incluyen cuando no son `null`.
 *
 * @param resource Fila no nula de recurso cloud de Prisma.
 * @returns Recurso cloud de dominio.
 */
export function toCloudResourceItem(resource: NonNullable<PrismaCloudResource>): CloudResourceItem {
  return {
    id: resource.id,
    provider: resource.provider,
    externalResourceId: resource.externalResourceId,
    ...(resource.name !== null ? { name: resource.name } : {}),
    resourceType: resource.resourceType,
    serviceName: resource.serviceName,
    ...(resource.regionId !== null ? { regionId: resource.regionId } : {}),
    status: resource.status,
    firstSeenAt: resource.firstSeenAt,
    lastSeenAt: resource.lastSeenAt,
  };
}

/**
 * Mapea una fila de `resource_metric_samples` al modelo de dominio
 * {@link ResourceMetricSampleItem}.
 *
 * Casos borde: `value` (`Decimal`) se convierte a `number` con `Number()`;
 * `metricUnit` solo se incluye cuando no es `null`.
 *
 * @param sample Fila no nula de muestra de métrica de Prisma.
 * @returns Muestra de métrica técnica de dominio.
 */
export function toResourceMetricSampleItem(
  sample: NonNullable<PrismaResourceMetricSample>,
): ResourceMetricSampleItem {
  return {
    id: sample.id,
    provider: sample.provider,
    externalResourceId: sample.externalResourceId,
    ...(sample.cloudResourceId !== null ? { cloudResourceId: sample.cloudResourceId } : {}),
    metricName: sample.metricName,
    ...(sample.metricUnit !== null ? { metricUnit: sample.metricUnit } : {}),
    value: Number(sample.value),
    sampledAt: sample.sampledAt,
    granularitySeconds: sample.granularitySeconds,
  };
}

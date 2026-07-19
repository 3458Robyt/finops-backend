import type {
  CostDataOptions,
  CostMetricQuery,
  ICostRepository,
} from '../../domain/interfaces/ICostRepository.js';
import type { InternalCostMetric } from '../../domain/models/InternalCostMetric.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { CloudProvider } from '../../generated/prisma/client.js';

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link ICostRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: persistencia y lectura de métricas de coste normalizadas
 * (tabla `cost_metrics`, modelo FOCUS). Traduce entre el modelo interno de
 * dominio {@link InternalCostMetric} y las filas de Prisma, calculando los
 * periodos de cargo, el hash de identidad para deduplicación y el mapeo de
 * proveedor cloud.
 */
export class PrismaCostRepository implements ICostRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Recupera métricas de coste de un tenant dentro de un rango de fechas,
   * aplicando filtros opcionales por proveedor y cuenta cloud.
   *
   * El rango se interpreta como semiabierto sobre `chargePeriodStart`
   * (`>= startDate` y `< endDate`). Los resultados se ordenan por periodo de
   * cargo y nombre de servicio. Cada fila se reproyecta al modelo de dominio
   * {@link InternalCostMetric} (ver conversiones de `Decimal -> number`).
   *
   * @param query Criterios de consulta (tenant, rango de fechas y filtros
   *   opcionales de proveedor/cuenta).
   * @returns Lista de métricas de dominio; arreglo vacío si no hay coincidencias.
   */
  public async findByDateRange(query: CostMetricQuery): Promise<InternalCostMetric[]> {
    const rows = await this.prisma.costMetric.findMany({
      where: {
        tenantId: query.tenantId,
        chargePeriodStart: {
          gte: query.startDate,
          lt: query.endDate,
        },
        ...(query.providerName !== undefined ? { provider: this.toCloudProvider(query.providerName) } : {}),
        ...(query.cloudAccountId !== undefined ? { cloudAccountId: query.cloudAccountId } : {}),
      },
      orderBy: [
        { chargePeriodStart: 'asc' },
        { serviceName: 'asc' },
      ],
    });

    return rows.map((row) => ({
      resourceId: row.resourceId,
      service: row.serviceName,
      amount: Number(row.billedCost),
      currency: row.billingCurrency,
      ...(row.consumedQuantity !== null ? { usage: Number(row.consumedQuantity) } : {}),
      ...(row.consumedUnit !== null ? { usageUnit: row.consumedUnit } : {}),
      timestamp: row.chargePeriodStart,
      tags: this.toStringRecord(row.tags),
    }));
  }

  public async getDataOptions(tenantId: string, period?: string): Promise<CostDataOptions> {
    const periodRows = await this.prisma.$queryRaw<readonly { period: Date; metric_count: bigint }[]>`
      SELECT date_trunc('month', charge_period_start) AS period, COUNT(*)::bigint AS metric_count
      FROM cost_metrics
      WHERE tenant_id = ${tenantId}
      GROUP BY date_trunc('month', charge_period_start)
      ORDER BY period DESC
    `;
    const periods = periodRows.map((row) => ({ period: row.period.toISOString().slice(0, 7), metricCount: Number(row.metric_count) }));
    const selectedPeriod = period ?? periods[0]?.period;
    if (selectedPeriod === undefined) return { periods, cloudAccounts: [], services: [], regions: [], currencies: [] };
    const [year, month] = selectedPeriod.split('-').map(Number);
    const start = new Date(Date.UTC(year!, month! - 1, 1));
    const end = new Date(Date.UTC(year!, month!, 1));
    const where = { tenantId, chargePeriodStart: { gte: start, lt: end } };
    const [dimensions, accounts] = await Promise.all([
      this.prisma.costMetric.findMany({ where, select: { cloudAccountId: true, serviceName: true, regionId: true, billingCurrency: true }, distinct: ['cloudAccountId', 'serviceName', 'regionId', 'billingCurrency'] }),
      this.prisma.cloudAccount.findMany({ where: { tenantId }, select: { id: true, name: true, provider: true } }),
    ]);
    const accountIds = new Set(dimensions.map((row) => row.cloudAccountId));
    return {
      periods,
      ...(periods[0] === undefined ? {} : { latestPeriod: periods[0].period }),
      cloudAccounts: accounts.filter((account) => accountIds.has(account.id)).map((account) => ({ ...account, provider: String(account.provider) })),
      services: [...new Set(dimensions.map((row) => row.serviceName))].sort(),
      regions: [...new Set(dimensions.map((row) => row.regionId).filter((region): region is string => region !== null))].sort(),
      currencies: [...new Set(dimensions.map((row) => row.billingCurrency))].sort(),
    };
  }

  /**
   * Normaliza y valida el nombre de proveedor recibido convirtiéndolo al enum
   * de Prisma {@link CloudProvider}.
   *
   * Normaliza recortando espacios y pasando a mayúsculas. Solo admite los
   * proveedores soportados para persistencia (`AWS`, `OCI`).
   *
   * @param providerName Nombre de proveedor en texto libre.
   * @returns Valor del enum `CloudProvider` correspondiente.
   * @throws Error si el proveedor no está soportado para persistencia.
   */
  private toCloudProvider(providerName: string): CloudProvider {
    const normalized = providerName.trim().toUpperCase();

    if (normalized === CloudProvider.AWS || normalized === CloudProvider.OCI) {
      return normalized;
    }

    throw new Error(`Unsupported cloud provider for persistence: ${providerName}`);
  }

  /**
   * Convierte un valor JSON arbitrario de Prisma en un diccionario inmutable de
   * pares clave/valor de tipo cadena.
   *
   * Casos borde: devuelve un objeto vacío si el valor es `null`, no es un objeto
   * o es un arreglo. Además filtra cualquier entrada cuyo valor no sea `string`,
   * garantizando un `Record<string, string>` homogéneo.
   *
   * @param value Valor JSON crudo (p. ej. la columna `tags`).
   * @returns Diccionario de solo lectura con las entradas de tipo cadena.
   */
  private toStringRecord(value: unknown): Readonly<Record<string, string>> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const output: Record<string, string> = {};

    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === 'string') {
        output[key] = raw;
      }
    }

    return output;
  }

}

import { createHash } from 'node:crypto';
import type {
  CostMetricBatchContext,
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
   * Inserta un lote de métricas de coste de forma idempotente.
   *
   * Detalles relevantes del mapeo dominio -> fila Prisma:
   * - El periodo de cargo se deriva del `timestamp` de la métrica:
   *   `chargePeriodStart = timestamp` y `chargePeriodEnd = timestamp + 1 día`
   *   (granularidad diaria).
   * - `billingAccountId`/`subAccountId` se resuelven desde las etiquetas (tags)
   *   con respaldo (fallback) entre claves; si no hay valor, quedan en `null`.
   * - `billedCost` y `effectiveCost` se inicializan con el mismo importe; la
   *   divisa de facturación y de tarificación se fijan a `metric.currency`.
   * - `metricIdentityHash` permite deduplicar: junto con `skipDuplicates: true`
   *   evita insertar filas repetidas en reintentos de ingesta.
   *
   * @param context Contexto del lote (tenant, cuenta cloud, proveedor, run de
   *   ingesta opcional) que aplica a todas las métricas.
   * @param metrics Métricas internas a persistir.
   * @returns Número de filas efectivamente insertadas (excluye duplicados
   *   omitidos); 0 si el lote viene vacío.
   */
  public async insertBatch(
    context: CostMetricBatchContext,
    metrics: readonly InternalCostMetric[],
  ): Promise<number> {
    if (metrics.length === 0) {
      return 0;
    }

    const provider = this.toCloudProvider(context.providerName);

    const result = await this.prisma.costMetric.createMany({
      data: metrics.map((metric) => {
        const chargePeriodStart = metric.timestamp;
        const chargePeriodEnd = this.addDays(chargePeriodStart, 1);

        const billingAccountId = this.getTag(metric, 'accountId') ?? this.getTag(metric, 'tenantId') ?? null;
        const subAccountId = this.getTag(metric, 'accountId') ?? this.getTag(metric, 'compartmentId') ?? null;

        return {
          tenantId: context.tenantId,
          cloudAccountId: context.cloudAccountId,
          ...(context.ingestionRunId !== undefined ? { ingestionRunId: context.ingestionRunId } : {}),
          provider,
          billingAccountId,
          subAccountId,
          serviceName: metric.service,
          resourceId: metric.resourceId,
          chargePeriodStart,
          chargePeriodEnd,
          billedCost: metric.amount,
          effectiveCost: metric.amount,
          billingCurrency: metric.currency,
          pricingCurrency: metric.currency,
          ...(metric.usage !== undefined ? { consumedQuantity: metric.usage } : {}),
          ...(metric.usageUnit !== undefined ? { consumedUnit: metric.usageUnit } : {}),
          metricIdentityHash: this.buildMetricIdentityHash(context, metric),
          tags: metric.tags,
        };
      }),
      skipDuplicates: true,
    });

    return result.count;
  }

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
   * Construye un hash de identidad determinista (SHA-256) que identifica de
   * forma única una métrica de coste.
   *
   * Combina tenant, cuenta cloud, proveedor, timestamp (ISO), servicio, recurso
   * y divisa. Sirve como clave de deduplicación: dos ingestas de la misma
   * métrica producen el mismo hash, evitando duplicados en `insertBatch`.
   *
   * @param context Contexto del lote (tenant, cuenta, proveedor).
   * @param metric Métrica cuyos atributos identitarios se hashean.
   * @returns Hash hexadecimal SHA-256 de la identidad de la métrica.
   */
  private buildMetricIdentityHash(
    context: CostMetricBatchContext,
    metric: InternalCostMetric,
  ): string {
    const identity = [
      context.tenantId,
      context.cloudAccountId,
      context.providerName,
      metric.timestamp.toISOString(),
      metric.service,
      metric.resourceId,
      metric.currency,
    ];

    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }

  /**
   * Obtiene el valor de una etiqueta (tag) de la métrica por su clave.
   *
   * @param metric Métrica de la que se leen las etiquetas.
   * @param key Clave de la etiqueta buscada.
   * @returns El valor de la etiqueta, o `undefined` si no existe.
   */
  private getTag(metric: InternalCostMetric, key: string): string | undefined {
    return metric.tags[key];
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

  /**
   * Suma un número de días a una fecha en UTC, sin mutar la fecha original.
   *
   * Opera sobre la componente de día en UTC para evitar desfases por zona
   * horaria al calcular el fin del periodo de cargo.
   *
   * @param date Fecha base.
   * @param days Número de días a sumar.
   * @returns Nueva instancia de `Date` desplazada en UTC.
   */
  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }
}

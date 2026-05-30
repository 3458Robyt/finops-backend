import type {
  PersistCostAnomalyInput,
  PersistCostForecastInput,
} from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';

/**
 * ═══════════════════════════════════════════════════════════════
 * Persistencia transaccional de anomalías y pronósticos de costo
 * ═══════════════════════════════════════════════════════════════
 *
 * Aísla las operaciones de reemplazo atómico (`replace*`) del repositorio de
 * analítica. Cada operación se ejecuta dentro de una transacción que toma un
 * lock consultivo a nivel de transacción (`pg_advisory_xact_lock`) basado en un
 * hash de `<entidad>:<tenantId>` para serializar regeneraciones concurrentes del
 * mismo tenant, borra el conjunto previo, inserta el nuevo lote (con
 * `skipDuplicates`) y relee el resultado ordenado. Devuelven filas crudas de
 * Prisma para que el repositorio las mapee a dominio. Todas filtran por
 * `tenantId` (aislamiento multi-tenant).
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 *
 * @module infrastructure/repositories/queries/costAnalyticsPersistenceQueries
 */

type CostAnomalyRow = NonNullable<Awaited<ReturnType<PrismaClient['costAnomaly']['findFirst']>>>;
type CostForecastRow = NonNullable<Awaited<ReturnType<PrismaClient['costForecast']['findFirst']>>>;

/**
 * Reemplaza atómicamente todas las anomalías de coste de un tenant por el nuevo
 * conjunto calculado.
 *
 * Ejecuta dentro de una transacción que: (1) toma un lock consultivo de
 * transacción (`pg_advisory_xact_lock` sobre `cost_anomalies:<tenantId>`) para
 * serializar regeneraciones concurrentes; (2) borra las anomalías existentes del
 * tenant; (3) inserta el nuevo lote (con `skipDuplicates`); y (4) relee el
 * conjunto resultante ordenado por severidad y detección descendentes (máx. 100).
 *
 * @param prisma Cliente Prisma.
 * @param tenantId Tenant cuyas anomalías se reemplazan (aislamiento multi-tenant).
 * @param anomalies Nuevo conjunto de anomalías a persistir.
 * @returns Filas crudas de anomalía persistidas (máx. 100).
 */
export async function replaceTenantAnomalies(
  prisma: PrismaClient,
  tenantId: string,
  anomalies: readonly PersistCostAnomalyInput[],
): Promise<CostAnomalyRow[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${`cost_anomalies:${tenantId}`}))`;
    await tx.costAnomaly.deleteMany({ where: { tenantId } });

    if (anomalies.length > 0) {
      await tx.costAnomaly.createMany({
        data: anomalies.map((item) => ({
        tenantId: item.tenantId,
        ...(item.cloudAccountId !== undefined ? { cloudAccountId: item.cloudAccountId } : {}),
        ...(item.provider !== undefined ? { provider: item.provider as never } : {}),
        ...(item.serviceName !== undefined ? { serviceName: item.serviceName } : {}),
        ...(item.resourceId !== undefined ? { resourceId: item.resourceId } : {}),
        ...(item.environment !== undefined ? { environment: item.environment } : {}),
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        baselineCost: item.baselineCost,
        observedCost: item.observedCost,
        deltaAmount: item.deltaAmount,
        deltaPercent: item.deltaPercent,
        ...(item.zScore !== undefined ? { zScore: item.zScore } : {}),
        severity: item.severity,
        status: item.status,
        explanation: item.explanation,
        ...(item.evidence !== undefined ? { evidence: item.evidence as Prisma.InputJsonValue } : {}),
        })),
        skipDuplicates: true,
      });
    }

    return tx.costAnomaly.findMany({
      where: { tenantId },
      orderBy: [
        { severity: 'desc' },
        { detectedAt: 'desc' },
      ],
      take: 100,
    });
  });
}

/**
 * Reemplaza atómicamente todos los pronósticos de coste de un tenant por el
 * nuevo conjunto calculado.
 *
 * Mismo patrón que {@link replaceTenantAnomalies}: lock consultivo de
 * transacción (`pg_advisory_xact_lock` sobre `cost_forecasts:<tenantId>`),
 * borrado del conjunto previo, inserción del nuevo lote (con `skipDuplicates`) y
 * relectura ordenada por mes ascendente y coste previsto descendente (máx. 100).
 *
 * @param prisma Cliente Prisma.
 * @param tenantId Tenant cuyos pronósticos se reemplazan (aislamiento multi-tenant).
 * @param forecasts Nuevo conjunto de pronósticos a persistir.
 * @returns Filas crudas de pronóstico persistidas (máx. 100).
 */
export async function replaceTenantForecasts(
  prisma: PrismaClient,
  tenantId: string,
  forecasts: readonly PersistCostForecastInput[],
): Promise<CostForecastRow[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${`cost_forecasts:${tenantId}`}))`;
    await tx.costForecast.deleteMany({ where: { tenantId } });

    if (forecasts.length > 0) {
      await tx.costForecast.createMany({
        data: forecasts.map((item) => ({
        tenantId: item.tenantId,
        ...(item.cloudAccountId !== undefined ? { cloudAccountId: item.cloudAccountId } : {}),
        ...(item.provider !== undefined ? { provider: item.provider as never } : {}),
        ...(item.serviceName !== undefined ? { serviceName: item.serviceName } : {}),
        groupBy: item.groupBy,
        groupKey: item.groupKey,
        forecastMonth: item.forecastMonth,
        predictedCost: item.predictedCost,
        lowerBound: item.lowerBound,
        upperBound: item.upperBound,
        method: item.method,
        confidence: item.confidence,
        currency: item.currency,
        ...(item.evidence !== undefined ? { evidence: item.evidence as Prisma.InputJsonValue } : {}),
        })),
        skipDuplicates: true,
      });
    }

    return tx.costForecast.findMany({
      where: { tenantId },
      orderBy: [
        { forecastMonth: 'asc' },
        { predictedCost: 'desc' },
      ],
      take: 100,
    });
  });
}

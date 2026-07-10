import type {
  AnalyticsFilters,
  CostAnomaly,
  CostAnalyticsSnapshot,
  CostForecast,
  ICostAnalyticsRepository,
  MonthlyCostPoint,
  MonthlyUsagePoint,
  PersistCostAnomalyInput,
  PersistCostForecastInput,
} from '../../domain/interfaces/ICostAnalyticsRepository.js';
import { type PrismaClient } from '../../generated/prisma/client.js';
import {
  toAccountItem,
  toAnomalyDomain,
  toEnvironmentItem,
  toForecastDomain,
  toProviderItem,
  toResourceItem,
  toServiceItem,
  toUsageItem,
} from './mappers/costAnalyticsMappers.js';
import { runSnapshotAggregations } from './queries/costAnalyticsSnapshotQueries.js';
import {
  queryMonthlyCostRows,
  queryMonthlyUsageRows,
} from './queries/costAnalyticsSeriesQueries.js';
import {
  replaceTenantAnomalies,
  replaceTenantForecasts,
} from './queries/costAnalyticsPersistenceQueries.js';

export class PrismaCostAnalyticsRepository implements ICostAnalyticsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Construye el snapshot analítico de costes más reciente de un tenant.
   *
   * Estrategia: primero localiza el `chargePeriodStart` máximo del tenant y, a
   * partir de él, calcula los límites del mes natural en UTC (`periodStart`
   * inclusive, `periodEnd` exclusivo). Si el tenant no tiene métricas, devuelve
   * un snapshot vacío (ver {@link emptySnapshot}).
   *
   * Luego ejecuta en paralelo varias agregaciones (todas filtradas por
   * `tenant_id` para aislamiento multi-tenant y por el rango mensual):
   * - resumen (conteo y suma de `billed_cost`),
   * - divisa predominante (la más frecuente en el periodo),
   * - desgloses por proveedor, cuenta (join con `cloud_accounts`), servicio (top
   *   10), entorno (etiqueta `tags->>'environment'`) y recursos (top 10,
   *   excluyendo `resource_id` vacío),
   * - top de uso por servicio/unidad consumida.
   * Finalmente añade anomalías (máx. 5) y pronósticos (máx. 6). Los importes en
   * SQL se castean a `float8` para devolver `number` y no `Decimal`.
   *
   * @param tenantId Tenant del que se construye el snapshot.
   * @returns Snapshot analítico de costes; snapshot vacío si no hay métricas.
   */
  public async getLatestTenantSnapshot(tenantId: string): Promise<CostAnalyticsSnapshot> {
    const bounds = await this.prisma.costMetric.aggregate({
      where: { tenantId },
      _max: { chargePeriodStart: true },
    });

    const latestMetricDate = bounds._max.chargePeriodStart;

    if (latestMetricDate === null) {
      return this.emptySnapshot(tenantId);
    }

    const periodStart = new Date(Date.UTC(
      latestMetricDate.getUTCFullYear(),
      latestMetricDate.getUTCMonth(),
      1,
    ));
    const periodEnd = new Date(Date.UTC(
      latestMetricDate.getUTCFullYear(),
      latestMetricDate.getUTCMonth() + 1,
      1,
    ));

    const aggregations = await runSnapshotAggregations(this.prisma, tenantId, periodStart, periodEnd);

    const [anomalies, forecasts] = await Promise.all([
      this.findAnomalies(tenantId),
      this.findForecasts(tenantId),
    ]);

    return {
      tenantId,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      totalCost: aggregations.summary.totalCost,
      currency: aggregations.currencies[0]?.currency ?? 'USD',
      metricCount: aggregations.summary.metricCount,
      providers: aggregations.providers.map(toProviderItem),
      accounts: aggregations.accounts.map(toAccountItem),
      services: aggregations.services.map(toServiceItem),
      environments: aggregations.environments.map(toEnvironmentItem),
      topResources: aggregations.topResources.map(toResourceItem),
      topUsage: aggregations.topUsage.map(toUsageItem),
      anomalies: anomalies.slice(0, 5),
      forecasts: forecasts.slice(0, 6),
    };
  }

  /**
   * Devuelve la serie mensual de costes de un tenant, agrupada por la dimensión
   * indicada en los filtros (`provider`, `account`, `service`, `resource` o
   * `environment`; por defecto `service`).
   *
   * Construye dinámicamente las cláusulas `where` a partir de los filtros
   * opcionales (rango temporal semiabierto, proveedor, cuenta, servicio),
   * partiendo siempre del filtro `tenant_id` (aislamiento multi-tenant). Agrega
   * por mes (`date_trunc('month', ...)`) y por la expresión de agrupación
   * (ver {@link groupExpression}); el coste se castea a `float8`.
   *
   * @param tenantId Tenant cuya serie se calcula.
   * @param filters Filtros opcionales de rango, dimensiones y `groupBy`.
   * @returns Puntos mensuales de coste; arreglo vacío si no hay datos. Los
   *   campos dimensionales anulables solo se incluyen cuando no son `null`.
   */
  public async getMonthlyCostSeries(
    tenantId: string,
    filters: AnalyticsFilters = {},
  ): Promise<MonthlyCostPoint[]> {
    const groupBy = filters.groupBy ?? 'service';
    const rows = await queryMonthlyCostRows(this.prisma, tenantId, groupBy, filters);

    return rows.map((row) => ({
      month: row.month.toISOString(),
      groupBy,
      groupKey: row.group_key,
      ...(row.provider !== null ? { provider: row.provider } : {}),
      ...(row.cloud_account_id !== null ? { cloudAccountId: row.cloud_account_id } : {}),
      ...(row.service_name !== null ? { serviceName: row.service_name } : {}),
      ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
      ...(row.environment !== null ? { environment: row.environment } : {}),
      cost: row.total_cost,
      currency: row.currency,
      metricCount: row.metric_count,
    }));
  }

  /**
   * Devuelve la serie mensual de uso (consumo) de un tenant, agrupada por la
   * dimensión indicada y por unidad consumida.
   *
   * Igual que {@link getMonthlyCostSeries}, pero restringe a métricas con
   * cantidad y unidad de consumo válidas (no nulas ni vacías) y agrega también
   * por `consumed_unit`. Calcula un coste unitario derivado
   * (`total_cost / consumed_quantity`) solo cuando la cantidad es positiva; el
   * `groupKey` se enriquece con la unidad entre paréntesis para distinguir
   * series con distinta unidad.
   *
   * @param tenantId Tenant cuya serie de uso se calcula.
   * @param filters Filtros opcionales de rango, dimensiones y `groupBy`.
   * @returns Puntos mensuales de uso (con `unitCost` cuando aplica); arreglo
   *   vacío si no hay datos.
   */
  public async getMonthlyUsageSeries(
    tenantId: string,
    filters: AnalyticsFilters = {},
  ): Promise<MonthlyUsagePoint[]> {
    const groupBy = filters.groupBy ?? 'service';
    const rows = await queryMonthlyUsageRows(this.prisma, tenantId, groupBy, filters);

    return rows.map((row) => {
      const unitCost = row.consumed_quantity > 0 ? row.total_cost / row.consumed_quantity : undefined;

      return {
        month: row.month.toISOString(),
        groupBy,
        groupKey: `${row.group_key} (${row.consumed_unit})`,
        ...(row.provider !== null ? { provider: row.provider } : {}),
        ...(row.cloud_account_id !== null ? { cloudAccountId: row.cloud_account_id } : {}),
        ...(row.service_name !== null ? { serviceName: row.service_name } : {}),
        ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
        ...(row.environment !== null ? { environment: row.environment } : {}),
        consumedQuantity: row.consumed_quantity,
        consumedUnit: row.consumed_unit,
        cost: row.total_cost,
        ...(unitCost !== undefined ? { unitCost } : {}),
        currency: row.currency,
        metricCount: row.metric_count,
      };
    });
  }

  /**
   * Lista las anomalías de coste persistidas de un tenant, aplicando filtros
   * opcionales.
   *
   * Filtra por `tenantId` (aislamiento multi-tenant) y, opcionalmente, por rango
   * de `periodStart`, proveedor, cuenta y servicio. Ordena por severidad y fecha
   * de detección descendentes, limitando a 100 resultados.
   *
   * @param tenantId Tenant cuyas anomalías se consultan.
   * @param filters Filtros opcionales.
   * @returns Lista de anomalías de dominio; arreglo vacío si no hay coincidencias.
   */
  public async findAnomalies(
    tenantId: string,
    filters: AnalyticsFilters = {},
  ): Promise<CostAnomaly[]> {
    const rows = await this.prisma.costAnomaly.findMany({
      where: {
        tenantId,
        ...(filters.from !== undefined ? { periodStart: { gte: filters.from } } : {}),
        ...(filters.to !== undefined ? { periodStart: { lt: filters.to } } : {}),
        ...(filters.provider !== undefined ? { provider: filters.provider as never } : {}),
        ...(filters.cloudAccountId !== undefined ? { cloudAccountId: filters.cloudAccountId } : {}),
        ...(filters.serviceName !== undefined ? { serviceName: filters.serviceName } : {}),
      },
      orderBy: [
        { severity: 'desc' },
        { detectedAt: 'desc' },
      ],
      take: 100,
    });

    return rows.map((row) => toAnomalyDomain(row));
  }

  /**
   * Reemplaza atómicamente todas las anomalías de coste de un tenant por el
   * nuevo conjunto calculado.
   *
   * Ejecuta dentro de una transacción que: (1) toma un lock consultivo a nivel de
   * transacción (`pg_advisory_xact_lock`) basado en un hash de
   * `cost_anomalies:<tenantId>` para serializar regeneraciones concurrentes del
   * mismo tenant y evitar condiciones de carrera; (2) borra las anomalías
   * existentes del tenant; (3) inserta el nuevo lote (con `skipDuplicates`); y
   * (4) relee el conjunto resultante ordenado por severidad y detección.
   *
   * @param tenantId Tenant cuyas anomalías se reemplazan (aislamiento
   *   multi-tenant).
   * @param anomalies Nuevo conjunto de anomalías a persistir.
   * @returns Las anomalías persistidas en formato de dominio (máx. 100).
   */
  public async replaceAnomalies(
    tenantId: string,
    anomalies: readonly PersistCostAnomalyInput[],
  ): Promise<CostAnomaly[]> {
    const rows = await replaceTenantAnomalies(this.prisma, tenantId, anomalies);

    return rows.map((row) => toAnomalyDomain(row));
  }

  /**
   * Lista los pronósticos de coste persistidos de un tenant, con filtros
   * opcionales.
   *
   * Filtra por `tenantId` (aislamiento multi-tenant) y, opcionalmente, por
   * proveedor, cuenta, servicio y `groupBy`. Ordena por mes pronosticado
   * ascendente y coste previsto descendente, limitando a 100 resultados.
   *
   * @param tenantId Tenant cuyos pronósticos se consultan.
   * @param filters Filtros opcionales.
   * @returns Lista de pronósticos de dominio; arreglo vacío si no hay
   *   coincidencias.
   */
  public async findForecasts(
    tenantId: string,
    filters: AnalyticsFilters = {},
  ): Promise<CostForecast[]> {
    const rows = await this.prisma.costForecast.findMany({
      where: {
        tenantId,
        ...(filters.provider !== undefined ? { provider: filters.provider as never } : {}),
        ...(filters.cloudAccountId !== undefined ? { cloudAccountId: filters.cloudAccountId } : {}),
        ...(filters.serviceName !== undefined ? { serviceName: filters.serviceName } : {}),
        ...(filters.groupBy !== undefined ? { groupBy: filters.groupBy } : {}),
      },
      orderBy: [
        { forecastMonth: 'asc' },
        { predictedCost: 'desc' },
      ],
      take: 100,
    });

    return rows.map((row) => toForecastDomain(row));
  }

  /**
   * Reemplaza atómicamente todos los pronósticos de coste de un tenant por el
   * nuevo conjunto calculado.
   *
   * Mismo patrón que {@link replaceAnomalies}: lock consultivo de transacción
   * (`pg_advisory_xact_lock` sobre `cost_forecasts:<tenantId>`) para serializar
   * regeneraciones concurrentes, borrado del conjunto previo, inserción del nuevo
   * lote (con `skipDuplicates`) y relectura ordenada.
   *
   * @param tenantId Tenant cuyos pronósticos se reemplazan (aislamiento
   *   multi-tenant).
   * @param forecasts Nuevo conjunto de pronósticos a persistir.
   * @returns Los pronósticos persistidos en formato de dominio (máx. 100).
   */
  public async replaceForecasts(
    tenantId: string,
    forecasts: readonly PersistCostForecastInput[],
  ): Promise<CostForecast[]> {
    const rows = await replaceTenantForecasts(this.prisma, tenantId, forecasts);

    return rows.map((row) => toForecastDomain(row));
  }

  /**
   * Crea un snapshot vacío (sin métricas) usado cuando el tenant aún no tiene
   * datos de coste. Fija divisa por defecto `USD` y periodos a la fecha actual.
   *
   * @param tenantId Tenant para el que se genera el snapshot vacío.
   * @returns Snapshot con totales en cero y colecciones vacías.
   */
  private emptySnapshot(tenantId: string): CostAnalyticsSnapshot {
    const now = new Date();

    return {
      tenantId,
      periodStart: now.toISOString(),
      periodEnd: now.toISOString(),
      totalCost: 0,
      currency: 'USD',
      metricCount: 0,
      providers: [],
      accounts: [],
      services: [],
      environments: [],
      topResources: [],
      anomalies: [],
      forecasts: [],
    };
  }
}

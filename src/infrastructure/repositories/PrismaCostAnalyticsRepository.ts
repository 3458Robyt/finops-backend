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
import { toAnomalyDomain, toForecastDomain } from './mappers/costAnalyticsMappers.js';
import { runSnapshotAggregations } from './queries/costAnalyticsSnapshotQueries.js';
import {
  queryMonthlyCostRows,
  queryMonthlyUsageRows,
} from './queries/costAnalyticsSeriesQueries.js';
import {
  replaceTenantAnomalies,
  replaceTenantForecasts,
} from './queries/costAnalyticsPersistenceQueries.js';
import { CurrencyConverter, normalizeCurrencyCode } from '../finance/CurrencyConverter.js';
import {
  projectMonthlyCostRows,
  projectMonthlyUsageRows,
  projectSnapshotAggregations,
} from './queries/costAnalyticsCurrencyProjection.js';

export class PrismaCostAnalyticsRepository implements ICostAnalyticsRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly currencyConverter?: CurrencyConverter,
  ) {}

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

    const reportingCurrency = normalizeCurrencyCode(await this.getReportingCurrency(tenantId));
    const aggregations = await runSnapshotAggregations(this.prisma, tenantId, periodStart, periodEnd);
    const projected = await projectSnapshotAggregations(aggregations, periodStart, reportingCurrency, this.currencyConverter);

    const [anomalies, forecasts] = await Promise.all([
      this.findAnomalies(tenantId),
      this.findForecasts(tenantId),
    ]);

    return {
      tenantId,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      totalCost: projected.summary.totalCost,
      currency: reportingCurrency,
      nativeTotals: aggregations.summary.byCurrency.map((item) => ({ currency: item.currency, amount: item.totalCost })),
      ...(projected.summary.conversionIssueCount === 0 ? {} : { conversionIssueCount: projected.summary.conversionIssueCount }),
      metricCount: aggregations.summary.metricCount,
      providers: projected.providers,
      accounts: projected.accounts,
      services: projected.services,
      environments: projected.environments,
      topResources: projected.topResources,
      topUsage: projected.topUsage,
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
    return [...await projectMonthlyCostRows(rows, groupBy, await this.getReportingCurrency(tenantId), this.currencyConverter)];
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
    return [...await projectMonthlyUsageRows(rows, groupBy, await this.getReportingCurrency(tenantId), this.currencyConverter)];
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

    const anomalies = rows.map((row) => toAnomalyDomain(row));
    if (this.currencyConverter === undefined) return anomalies;

    const reportingCurrency = await this.getReportingCurrency(tenantId);
    const convertible = anomalies.filter((anomaly) => anomaly.currency !== undefined);
    if (convertible.length === 0) return anomalies;
    const projections = await this.currencyConverter.convertMany(
      convertible.flatMap((anomaly) => [
        { amount: anomaly.baselineCost, currency: anomaly.currency ?? 'USD', at: new Date(anomaly.periodStart) },
        { amount: anomaly.observedCost, currency: anomaly.currency ?? 'USD', at: new Date(anomaly.periodStart) },
        { amount: anomaly.deltaAmount, currency: anomaly.currency ?? 'USD', at: new Date(anomaly.periodStart) },
      ]),
      reportingCurrency,
    );
    const projectedById = new Map(convertible.map((anomaly, index) => {
      const nativeCurrency = anomaly.currency;
      const baseline = projections[index * 3];
      const observed = projections[index * 3 + 1];
      const delta = projections[index * 3 + 2];
      if (baseline === undefined || observed === undefined || delta === undefined) return [anomaly.id, anomaly] as const;
      const native = {
        nativeBaselineCost: anomaly.baselineCost,
        nativeObservedCost: anomaly.observedCost,
        nativeDeltaAmount: anomaly.deltaAmount,
        nativeCurrency: nativeCurrency ?? 'USD',
        conversionStatus: mergeCurrencyStatus(baseline.status, observed.status, delta.status),
      } as const;
      return [anomaly.id, baseline.amount === null || observed.amount === null || delta.amount === null
        ? { ...anomaly, ...native }
        : { ...anomaly, baselineCost: baseline.amount, observedCost: observed.amount, deltaAmount: delta.amount, currency: reportingCurrency, ...native }] as const;
    }));
    return anomalies.map((anomaly) => projectedById.get(anomaly.id) ?? anomaly);
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

    const forecasts = rows.map((row) => toForecastDomain(row));
    if (this.currencyConverter === undefined) return forecasts;

    const reportingCurrency = await this.getReportingCurrency(tenantId);
    const projections = await this.currencyConverter.convertMany(
      forecasts.flatMap((forecast) => [
        { amount: forecast.predictedCost, currency: forecast.currency, at: new Date(forecast.forecastMonth) },
        { amount: forecast.lowerBound, currency: forecast.currency, at: new Date(forecast.forecastMonth) },
        { amount: forecast.upperBound, currency: forecast.currency, at: new Date(forecast.forecastMonth) },
      ]),
      reportingCurrency,
    );

    return forecasts.map((forecast, index) => {
      const predicted = projections[index * 3];
      const lower = projections[index * 3 + 1];
      const upper = projections[index * 3 + 2];
      if (predicted === undefined || lower === undefined || upper === undefined) return forecast;
      const status = mergeCurrencyStatus(predicted.status, lower.status, upper.status);
      const native = {
        nativePredictedCost: forecast.predictedCost,
        nativeLowerBound: forecast.lowerBound,
        nativeUpperBound: forecast.upperBound,
        nativeCurrency: forecast.currency,
        conversionStatus: status,
      } as const;
      if (predicted.amount === null || lower.amount === null || upper.amount === null) return { ...forecast, ...native };
      return {
        ...forecast,
        predictedCost: predicted.amount,
        lowerBound: lower.amount,
        upperBound: upper.amount,
        currency: reportingCurrency,
        ...native,
      };
    });
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

  private async getReportingCurrency(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { reportingCurrency: true },
    });
    return normalizeCurrencyCode(tenant?.reportingCurrency ?? 'USD');
  }
}

function mergeCurrencyStatus(
  ...statuses: readonly CostForecast['conversionStatus'][]
): NonNullable<CostForecast['conversionStatus']> {
  if (statuses.includes('MISSING_RATE')) return 'MISSING_RATE';
  if (statuses.includes('UNSUPPORTED_CURRENCY')) return 'UNSUPPORTED_CURRENCY';
  if (statuses.includes('CONVERTED')) return 'CONVERTED';
  return 'NOT_REQUIRED';
}

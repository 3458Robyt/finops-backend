import type {
  AnalyticsFilters,
  AnalyticsGroupBy,
  CostAnomaly,
  CostForecast,
  CostTrend,
  ICostAnalyticsRepository,
  MonthlyUsagePoint,
  UsageInsight,
} from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type { AnomalyThresholds } from './analytics/anomalyDetector.js';
import { detectAnomalies } from './analytics/anomalyDetector.js';
import { generateForecasts } from './analytics/costForecaster.js';
import { buildTrends } from './analytics/costTrendBuilder.js';
import { buildUsageInsights } from './analytics/usageInsightBuilder.js';

/**
 * Consulta de analítica de costos.
 *
 * Define el tenant y los filtros opcionales (rango temporal, proveedor,
 * cuenta, servicio) y el criterio de agrupación para series y agregados.
 */
export interface AnalyticsQuery {
  readonly tenantId: string;
  /** Inicio del rango temporal (inclusive), opcional. */
  readonly from?: Date;
  /** Fin del rango temporal, opcional. */
  readonly to?: Date;
  /** Filtro por proveedor de nube (p. ej. "aws", "oci"). */
  readonly provider?: string;
  /** Filtro por cuenta de nube. */
  readonly cloudAccountId?: string;
  /** Filtro por nombre de servicio. */
  readonly serviceName?: string;
  /** Criterio de agrupación de las series (por servicio, cuenta, etc.). */
  readonly groupBy?: AnalyticsGroupBy;
}

/**
 * Resultado de un recálculo de analítica.
 *
 * Agrupa los artefactos derivados de la serie mensual: anomalías, forecasts,
 * tendencias e insights de consumo.
 */
export interface AnalyticsRecomputeResult {
  readonly anomalies: readonly CostAnomaly[];
  readonly forecasts: readonly CostForecast[];
  readonly trends: readonly CostTrend[];
  readonly usageInsights: readonly UsageInsight[];
  /** `true` si la serie tiene menos de 3 puntos, insuficientes para conclusiones robustas. */
  readonly insufficientData: boolean;
}

/**
 * Umbrales de detección de anomalías, resueltos desde el entorno.
 *
 * El delta absoluto mínimo es configurable vía `ANOMALY_MIN_DELTA_USD`
 * (evita ruido por variaciones triviales); los umbrales porcentuales de
 * severidad son constantes del dominio.
 */
const anomalyThresholds: AnomalyThresholds = {
  minAbsoluteDelta: Number.parseFloat(process.env['ANOMALY_MIN_DELTA_USD'] ?? '10'),
  mediumDeltaPercent: 25,
  highDeltaPercent: 50,
  criticalDeltaPercent: 100,
};

/**
 * Servicio de aplicación de analítica de costos FinOps.
 *
 * Responsabilidad: orquestar la obtención de series del repositorio y la
 * derivación de señales analíticas (tendencias, anomalías, forecasts e
 * insights de consumo), delegando cada cálculo en su módulo especializado
 * de `./analytics/*`, y persistir los recálculos. Toda la inteligencia se
 * basa en datos FOCUS (costo y consumo facturado), nunca en métricas técnicas.
 *
 * Colaborador inyectado (DIP):
 * - {@link ICostAnalyticsRepository}: acceso a series mensuales y persistencia
 *   de anomalías y forecasts.
 */
export class CostAnalyticsService {
  /**
   * Cola de recálculos en curso, indexada por tenant. Serializa los recálculos
   * de un mismo tenant para evitar condiciones de carrera y escrituras
   * concurrentes que se pisen entre sí (ver {@link recompute}).
   */
  private readonly recomputeQueues = new Map<string, Promise<AnalyticsRecomputeResult>>();

  /**
   * @param analyticsRepository - Repositorio de analítica de costos.
   */
  constructor(private readonly analyticsRepository: ICostAnalyticsRepository) {}

  /**
   * Obtiene las anomalías de costo persistidas para una consulta.
   *
   * @param query - Tenant y filtros de la consulta.
   * @returns Anomalías que cumplen los filtros.
   */
  public async getAnomalies(query: AnalyticsQuery): Promise<readonly CostAnomaly[]> {
    return this.analyticsRepository.findAnomalies(query.tenantId, this.toFilters(query));
  }

  /**
   * Obtiene los forecasts de costo persistidos para una consulta.
   *
   * @param query - Tenant y filtros de la consulta.
   * @returns Forecasts que cumplen los filtros.
   */
  public async getForecast(query: AnalyticsQuery): Promise<readonly CostForecast[]> {
    return this.analyticsRepository.findForecasts(query.tenantId, this.toFilters(query));
  }

  /**
   * Calcula las tendencias de costo a partir de la serie mensual.
   *
   * @param query - Tenant y filtros de la consulta.
   * @returns Tendencias por grupo, ordenadas por costo total descendente.
   */
  public async getTrends(query: AnalyticsQuery): Promise<readonly CostTrend[]> {
    const series = await this.analyticsRepository.getMonthlyCostSeries(query.tenantId, this.toFilters(query));
    return buildTrends(series);
  }

  /**
   * Obtiene la serie de consumo mensual (en las unidades reportadas por FOCUS).
   *
   * @param query - Tenant y filtros de la consulta.
   * @returns Puntos de consumo mensual.
   */
  public async getUsage(query: AnalyticsQuery): Promise<readonly MonthlyUsagePoint[]> {
    return this.analyticsRepository.getMonthlyUsageSeries(query.tenantId, this.toFilters(query));
  }

  /**
   * Calcula la "economía unitaria": los puntos con mayor costo por unidad consumida.
   *
   * Filtra los puntos sin `unitCost`, los ordena por costo unitario descendente
   * (usando `Math.max(consumedQuantity, 1)` para evitar división por cero) y
   * devuelve los 50 primeros.
   *
   * @param query - Tenant y filtros de la consulta.
   * @returns Hasta 50 puntos con mayor costo unitario.
   */
  public async getUnitEconomics(query: AnalyticsQuery): Promise<readonly MonthlyUsagePoint[]> {
    const series = await this.analyticsRepository.getMonthlyUsageSeries(query.tenantId, this.toFilters(query));
    return series
      .filter((point) => point.unitCost !== undefined)
      .sort((left, right) => (right.cost / Math.max(right.consumedQuantity, 1)) - (left.cost / Math.max(left.consumedQuantity, 1)))
      .slice(0, 50);
  }

  /**
   * Calcula los insights de eficiencia de consumo a partir de la serie de uso.
   *
   * @param query - Tenant y filtros de la consulta.
   * @returns Insights de consumo priorizados.
   */
  public async getEfficiencyInsights(query: AnalyticsQuery): Promise<readonly UsageInsight[]> {
    const series = await this.analyticsRepository.getMonthlyUsageSeries(query.tenantId, this.toFilters(query));
    return buildUsageInsights(series);
  }

  /**
   * Recalcula y **persiste** la analítica derivada (anomalías y forecasts) del
   * tenant, devolviendo además tendencias e insights.
   *
   * Concurrencia: encadena el recálculo a la promesa previa del mismo tenant
   * (cola serializada por `tenantId`) para garantizar que los recálculos no se
   * solapen; al terminar, limpia la entrada de la cola si sigue siendo la suya.
   *
   * Efectos secundarios: reemplaza anomalías y forecasts persistidos del tenant.
   *
   * @param query - Tenant y filtros de la consulta.
   * @returns Resultado consolidado del recálculo.
   */
  public async recompute(query: AnalyticsQuery): Promise<AnalyticsRecomputeResult> {
    const key = query.tenantId;
    const previous = this.recomputeQueues.get(key) ?? Promise.resolve(undefined);
    const current = previous
      .catch(() => undefined)
      .then(() => this.executeRecompute(query));

    this.recomputeQueues.set(key, current);

    try {
      return await current;
    } finally {
      if (this.recomputeQueues.get(key) === current) {
        this.recomputeQueues.delete(key);
      }
    }
  }

  /**
   * Ejecuta efectivamente el recálculo (invocado de forma serializada por
   * {@link recompute}).
   *
   * Obtiene la serie mensual agrupada (por defecto por `service`), detecta
   * anomalías y genera forecasts, y los **reemplaza** en el repositorio.
   * Marca `insufficientData` cuando hay menos de 3 puntos en la serie.
   */
  private async executeRecompute(query: AnalyticsQuery): Promise<AnalyticsRecomputeResult> {
    const filters = this.toFilters(query);
    const groupBy = filters.groupBy ?? 'service';
    const series = await this.analyticsRepository.getMonthlyCostSeries(query.tenantId, {
      ...filters,
      groupBy,
    });
    const anomalies = await this.analyticsRepository.replaceAnomalies(
      query.tenantId,
      detectAnomalies(query.tenantId, series, anomalyThresholds),
    );
    const forecasts = await this.analyticsRepository.replaceForecasts(
      query.tenantId,
      generateForecasts(query.tenantId, series),
    );

    return {
      anomalies,
      forecasts,
      trends: buildTrends(series),
      usageInsights: await this.getEfficiencyInsights(query),
      insufficientData: series.length < 3,
    };
  }

  /**
   * Convierte una {@link AnalyticsQuery} en los {@link AnalyticsFilters} del
   * repositorio, incluyendo solo los campos definidos (omite los `undefined`).
   */
  private toFilters(query: AnalyticsQuery): AnalyticsFilters {
    return {
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
      ...(query.provider !== undefined ? { provider: query.provider } : {}),
      ...(query.cloudAccountId !== undefined ? { cloudAccountId: query.cloudAccountId } : {}),
      ...(query.serviceName !== undefined ? { serviceName: query.serviceName } : {}),
      ...(query.groupBy !== undefined ? { groupBy: query.groupBy } : {}),
    };
  }
}

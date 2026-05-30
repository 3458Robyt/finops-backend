import type {
  AnalyticsGroupBy,
  CostAnalyticsSnapshot,
  CostAnomaly,
  CostAnomalySeverity,
  CostAnomalyStatus,
  CostForecast,
  MonthlyCostPoint,
  MonthlyUsagePoint,
} from './costAnalytics/costAnalyticsModels.js';

export * from './costAnalytics/costAnalyticsModels.js';

/**
 * Filtros opcionales aplicables a las consultas analíticas.
 *
 * Acotan los resultados por rango temporal y dimensiones, y permiten elegir la
 * agrupación de las series.
 */
export interface AnalyticsFilters {
  /** Inicio del rango temporal (inclusivo); opcional. */
  readonly from?: Date;
  /** Fin del rango temporal; opcional. */
  readonly to?: Date;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  /** Dimensión de agrupación de los resultados; opcional. */
  readonly groupBy?: AnalyticsGroupBy;
}

/**
 * Datos de entrada para persistir una anomalía de costo detectada.
 */
export interface PersistCostAnomalyInput {
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly provider?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  /** Inicio del periodo analizado. */
  readonly periodStart: Date;
  /** Fin del periodo analizado. */
  readonly periodEnd: Date;
  readonly baselineCost: number;
  readonly observedCost: number;
  readonly deltaAmount: number;
  readonly deltaPercent: number;
  readonly zScore?: number;
  readonly severity: CostAnomalySeverity;
  readonly status: CostAnomalyStatus;
  readonly explanation: string;
  readonly evidence?: unknown;
}

/**
 * Datos de entrada para persistir un pronóstico de costo generado.
 */
export interface PersistCostForecastInput {
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly provider?: string;
  readonly serviceName?: string;
  readonly groupBy: AnalyticsGroupBy | 'total';
  readonly groupKey: string;
  /** Mes pronosticado. */
  readonly forecastMonth: Date;
  readonly predictedCost: number;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly method: string;
  readonly confidence: number;
  readonly currency: string;
  readonly evidence?: unknown;
}

/**
 * Contrato de repositorio de analítica de costos.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en la capa de
 * infraestructura. Provee snapshots consolidados, series temporales y la
 * persistencia/consulta de anomalías y pronósticos de costo.
 */
export interface ICostAnalyticsRepository {
  /**
   * Obtiene el snapshot analítico más reciente de un tenant.
   *
   * @param tenantId - Tenant cuyo snapshot se solicita.
   * @returns Snapshot consolidado más reciente.
   */
  getLatestTenantSnapshot(tenantId: string): Promise<CostAnalyticsSnapshot>;

  /**
   * Obtiene la serie mensual de costos de un tenant.
   *
   * @param tenantId - Tenant a consultar.
   * @param filters  - Filtros opcionales de rango, dimensión y agrupación.
   * @returns Puntos mensuales de costo.
   */
  getMonthlyCostSeries(tenantId: string, filters?: AnalyticsFilters): Promise<MonthlyCostPoint[]>;

  /**
   * Obtiene la serie mensual de consumo y costo de un tenant.
   *
   * @param tenantId - Tenant a consultar.
   * @param filters  - Filtros opcionales de rango, dimensión y agrupación.
   * @returns Puntos mensuales de consumo.
   */
  getMonthlyUsageSeries(tenantId: string, filters?: AnalyticsFilters): Promise<MonthlyUsagePoint[]>;

  /**
   * Busca anomalías de costo de un tenant.
   *
   * @param tenantId - Tenant a consultar.
   * @param filters  - Filtros opcionales.
   * @returns Anomalías encontradas (posiblemente vacío).
   */
  findAnomalies(tenantId: string, filters?: AnalyticsFilters): Promise<CostAnomaly[]>;

  /**
   * Reemplaza el conjunto de anomalías de un tenant por el indicado.
   *
   * @param tenantId  - Tenant cuyas anomalías se reemplazan.
   * @param anomalies - Nuevo conjunto de anomalías a persistir.
   * @returns Anomalías persistidas resultantes.
   */
  replaceAnomalies(tenantId: string, anomalies: readonly PersistCostAnomalyInput[]): Promise<CostAnomaly[]>;

  /**
   * Busca pronósticos de costo de un tenant.
   *
   * @param tenantId - Tenant a consultar.
   * @param filters  - Filtros opcionales.
   * @returns Pronósticos encontrados (posiblemente vacío).
   */
  findForecasts(tenantId: string, filters?: AnalyticsFilters): Promise<CostForecast[]>;

  /**
   * Reemplaza el conjunto de pronósticos de un tenant por el indicado.
   *
   * @param tenantId  - Tenant cuyos pronósticos se reemplazan.
   * @param forecasts - Nuevo conjunto de pronósticos a persistir.
   * @returns Pronósticos persistidos resultantes.
   */
  replaceForecasts(tenantId: string, forecasts: readonly PersistCostForecastInput[]): Promise<CostForecast[]>;
}

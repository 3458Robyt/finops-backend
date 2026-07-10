/**
 * Modelos de lectura de analítica de costos (DTOs de salida).
 *
 * Reúne las estructuras de datos que el repositorio de analítica devuelve:
 * snapshot consolidado y sus desgloses por dimensión, series temporales,
 * insights de consumo, anomalías, pronósticos y tendencias, junto con los
 * alias de tipo compartidos. Se aíslan del contrato del puerto
 * ({@link ../ICostAnalyticsRepository}) para mantener cada archivo cohesionado
 * y por debajo del umbral de tamaño, sin acoplar el modelo de datos a la
 * interfaz del repositorio.
 *
 * @module domain/interfaces/costAnalytics/costAnalyticsModels
 */

/**
 * Costo agregado por proveedor cloud dentro de un snapshot analítico.
 */
export interface CostAnalyticsProviderItem {
  readonly provider: string;
  /** Costo total atribuido al proveedor en el periodo. */
  readonly totalCost: number;
  /** Número de métricas que componen el agregado. */
  readonly metricCount: number;
}

/**
 * Costo agregado por cuenta cloud dentro de un snapshot analítico.
 */
export interface CostAnalyticsAccountItem {
  readonly cloudAccountId: string;
  readonly provider: string;
  /** Nombre legible de la cuenta. */
  readonly name: string;
  readonly totalCost: number;
  readonly metricCount: number;
}

/**
 * Costo agregado por servicio dentro de un snapshot analítico.
 */
export interface CostAnalyticsServiceItem {
  readonly serviceName: string;
  readonly provider: string;
  readonly totalCost: number;
  readonly metricCount: number;
}

/**
 * Costo agregado por entorno (e.g., producción, staging) dentro de un snapshot.
 */
export interface CostAnalyticsEnvironmentItem {
  readonly environment: string;
  readonly totalCost: number;
  readonly metricCount: number;
}

/**
 * Costo agregado por recurso individual dentro de un snapshot analítico.
 */
export interface CostAnalyticsResourceItem {
  readonly resourceId: string;
  readonly serviceName: string;
  readonly provider: string;
  readonly totalCost: number;
  readonly metricCount: number;
}

/**
 * Agregado de consumo y costo por servicio dentro de un snapshot analítico.
 *
 * Combina cantidad consumida y costo para permitir el análisis de costo unitario.
 */
export interface CostAnalyticsUsageItem {
  readonly serviceName: string;
  readonly provider: string;
  /** Cantidad total consumida. */
  readonly consumedQuantity: number;
  /** Unidad de medida del consumo (e.g., GB-hora). */
  readonly consumedUnit: string;
  readonly totalCost: number;
  /** Costo por unidad consumida; opcional cuando no puede calcularse. */
  readonly unitCost?: number;
  /** Código de moneda de los importes. */
  readonly currency: string;
  readonly metricCount: number;
}

/**
 * Instantánea analítica consolidada de costos de un tenant para un periodo.
 *
 * Reúne totales y desgloses por distintas dimensiones (proveedor, cuenta,
 * servicio, entorno, recurso y consumo), además de señales derivadas
 * (insights, anomalías y pronósticos). Es la entrada principal para el motor de
 * contexto de la IA y los paneles analíticos.
 */
export interface CostAnalyticsSnapshot {
  readonly tenantId: string;
  /** Inicio del periodo cubierto, en formato ISO 8601. */
  readonly periodStart: string;
  /** Fin del periodo cubierto, en formato ISO 8601. */
  readonly periodEnd: string;
  readonly totalCost: number;
  readonly currency: string;
  readonly metricCount: number;
  /** Desglose de costos por proveedor. */
  readonly providers: readonly CostAnalyticsProviderItem[];
  /** Desglose de costos por cuenta. */
  readonly accounts: readonly CostAnalyticsAccountItem[];
  /** Desglose de costos por servicio. */
  readonly services: readonly CostAnalyticsServiceItem[];
  /** Desglose de costos por entorno. */
  readonly environments: readonly CostAnalyticsEnvironmentItem[];
  /** Recursos con mayor costo en el periodo. */
  readonly topResources: readonly CostAnalyticsResourceItem[];
  /** Principales agregados de consumo; opcional. */
  readonly topUsage?: readonly CostAnalyticsUsageItem[];
  /** Insights de consumo derivados; opcional. */
  readonly usageInsights?: readonly UsageInsight[];
  /** Anomalías de costo detectadas; opcional. */
  readonly anomalies?: readonly CostAnomaly[];
  /** Pronósticos de costo; opcional. */
  readonly forecasts?: readonly CostForecast[];
}

/** Dimensión por la cual se agrupan las métricas en una consulta analítica. */
export type AnalyticsGroupBy = 'provider' | 'account' | 'service' | 'resource' | 'environment';
/** Severidad de una anomalía de costo, en orden creciente de impacto. */
export type CostAnomalySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
/** Estado del ciclo de vida de una anomalía de costo. */
export type CostAnomalyStatus = 'OPEN' | 'LINKED_TO_RECOMMENDATION' | 'RESOLVED';

/**
 * Punto de una serie temporal mensual de costo.
 */
export interface MonthlyCostPoint {
  /** Mes del punto, en formato ISO (e.g., "2024-01"). */
  readonly month: string;
  /** Dimensión por la que se agrupa el punto. */
  readonly groupBy: AnalyticsGroupBy;
  /** Valor de la clave de agrupación para este punto. */
  readonly groupKey: string;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  /** Costo del mes para la agrupación indicada. */
  readonly cost: number;
  readonly currency: string;
  readonly metricCount: number;
}

/**
 * Punto de una serie temporal mensual de consumo y costo.
 */
export interface MonthlyUsagePoint {
  /** Mes del punto, en formato ISO (e.g., "2024-01"). */
  readonly month: string;
  /** Dimensión por la que se agrupa el punto. */
  readonly groupBy: AnalyticsGroupBy;
  /** Valor de la clave de agrupación para este punto. */
  readonly groupKey: string;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  /** Cantidad consumida en el mes. */
  readonly consumedQuantity: number;
  /** Unidad de medida del consumo. */
  readonly consumedUnit: string;
  readonly cost: number;
  /** Costo por unidad consumida; opcional. */
  readonly unitCost?: number;
  readonly currency: string;
  readonly metricCount: number;
}

/**
 * Tipo de insight de consumo derivado del análisis cruzado de costo y uso.
 *
 * - `CONSUMPTION_GROWTH`: crecimiento del consumo.
 * - `UNIT_COST_INCREASE`: aumento del costo unitario.
 * - `COST_USAGE_DIVERGENCE`: divergencia entre evolución de costo y de consumo.
 * - `HIGH_USAGE_LOW_COST`: alto consumo con bajo costo asociado.
 * - `INSUFFICIENT_USAGE_DATA`: datos de consumo insuficientes para concluir.
 */
export type UsageInsightKind =
  | 'CONSUMPTION_GROWTH'
  | 'UNIT_COST_INCREASE'
  | 'COST_USAGE_DIVERGENCE'
  | 'HIGH_USAGE_LOW_COST'
  | 'INSUFFICIENT_USAGE_DATA';

/** Severidad de un insight de consumo, en orden creciente de relevancia. */
export type UsageInsightSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Insight de consumo: hallazgo accionable derivado del análisis de costo y uso.
 */
export interface UsageInsight {
  readonly id: string;
  /** Categoría del insight. */
  readonly kind: UsageInsightKind;
  /** Severidad del insight. */
  readonly severity: UsageInsightSeverity;
  readonly groupBy: AnalyticsGroupBy;
  readonly groupKey: string;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  readonly title: string;
  readonly description: string;
  readonly consumedQuantity?: number;
  readonly consumedUnit?: string;
  readonly cost?: number;
  readonly unitCost?: number;
  /** Variación porcentual del consumo respecto al periodo de referencia; opcional. */
  readonly deltaConsumptionPercent?: number;
  /** Variación porcentual del costo respecto al periodo de referencia; opcional. */
  readonly deltaCostPercent?: number;
  /** Nivel de evidencia disponible que respalda el insight. */
  readonly evidenceLevel: 'COST_ONLY' | 'COST_AND_USAGE' | 'COST_USAGE_AND_TECHNICAL';
  readonly currency: string;
  /** Evidencia de soporte en forma estructurada. */
  readonly evidence: unknown;
}

/**
 * Anomalía de costo: desviación significativa respecto a un costo base esperado.
 */
export interface CostAnomaly {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly provider?: string;
  readonly serviceName?: string;
  readonly resourceId?: string;
  readonly environment?: string;
  /** Inicio del periodo analizado, en formato ISO 8601. */
  readonly periodStart: string;
  /** Fin del periodo analizado, en formato ISO 8601. */
  readonly periodEnd: string;
  /** Costo base esperado para el periodo. */
  readonly baselineCost: number;
  /** Costo observado en el periodo. */
  readonly observedCost: number;
  /** Diferencia absoluta entre el costo observado y el base. */
  readonly deltaAmount: number;
  /** Diferencia porcentual entre el costo observado y el base. */
  readonly deltaPercent: number;
  /** Puntuación z de la desviación; opcional. */
  readonly zScore?: number;
  readonly severity: CostAnomalySeverity;
  readonly status: CostAnomalyStatus;
  /** Explicación legible de la anomalía. */
  readonly explanation: string;
  readonly evidence?: unknown;
  /** Instante de detección de la anomalía, en formato ISO 8601. */
  readonly detectedAt: string;
}

/**
 * Pronóstico de costo para un periodo futuro y una agrupación dada.
 */
export interface CostForecast {
  readonly id: string;
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly provider?: string;
  readonly serviceName?: string;
  /** Dimensión de agrupación del pronóstico; `'total'` para el agregado global. */
  readonly groupBy: AnalyticsGroupBy | 'total';
  readonly groupKey: string;
  /** Mes pronosticado, en formato ISO (e.g., "2024-06"). */
  readonly forecastMonth: string;
  /** Costo pronosticado (valor central). */
  readonly predictedCost: number;
  /** Cota inferior del intervalo de predicción. */
  readonly lowerBound: number;
  /** Cota superior del intervalo de predicción. */
  readonly upperBound: number;
  /** Método de pronóstico empleado. */
  readonly method: string;
  /** Nivel de confianza del pronóstico. */
  readonly confidence: number;
  readonly currency: string;
  readonly evidence?: unknown;
  /** Instante de generación del pronóstico, en formato ISO 8601. */
  readonly generatedAt: string;
}

/**
 * Tendencia de costo: serie de puntos mensuales con su variación agregada.
 */
export interface CostTrend {
  /** Dimensión de agrupación de la tendencia; `'total'` para el agregado global. */
  readonly groupBy: AnalyticsGroupBy | 'total';
  readonly groupKey: string;
  readonly provider?: string;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  /** Puntos mensuales que componen la tendencia. */
  readonly points: readonly MonthlyCostPoint[];
  /** Costo total acumulado en la tendencia. */
  readonly totalCost: number;
  /** Variación absoluta entre extremos de la serie. */
  readonly deltaAmount: number;
  /** Variación porcentual entre extremos de la serie. */
  readonly deltaPercent: number;
  readonly currency: string;
}

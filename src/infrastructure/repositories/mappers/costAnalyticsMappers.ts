/**
 * Mappers puros y tipos de fila cruda del repositorio de analítica de costes.
 *
 * Responsabilidad: aislar la traducción `fila Prisma`/`fila cruda ($queryRaw)`
 * -> modelo de dominio, junto con las interfaces que describen la forma de esas
 * filas. Todas las funciones aquí son puras (no dependen de `this` ni del
 * cliente Prisma) para mantener el repositorio enfocado en el acceso a datos.
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 */
import type {
  CostAnalyticsAccountItem,
  CostAnalyticsEnvironmentItem,
  CostAnalyticsProviderItem,
  CostAnalyticsResourceItem,
  CostAnalyticsServiceItem,
  CostAnalyticsUsageItem,
  CostAnomaly,
  CostForecast,
} from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

/**
 * Fila cruda de la agregación por proveedor (consulta `$queryRaw`).
 * `total_cost` se castea a `float8` en SQL para evitar el tipo `Decimal`.
 */
export interface ProviderRow {
  readonly provider: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

export interface AccountRow {
  readonly cloud_account_id: string;
  readonly provider: string;
  readonly name: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

export interface ServiceRow {
  readonly service_name: string;
  readonly provider: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

export interface EnvironmentRow {
  readonly environment: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

export interface ResourceRow {
  readonly resource_id: string;
  readonly service_name: string;
  readonly provider: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

export interface CurrencyRow {
  readonly currency: string;
}

export interface MonthlyCostRow {
  readonly month: Date;
  readonly group_by: string;
  readonly group_key: string;
  readonly provider: string | null;
  readonly cloud_account_id: string | null;
  readonly service_name: string | null;
  readonly resource_id: string | null;
  readonly environment: string | null;
  readonly currency: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

export interface MonthlyUsageRow {
  readonly month: Date;
  readonly group_by: string;
  readonly group_key: string;
  readonly provider: string | null;
  readonly cloud_account_id: string | null;
  readonly service_name: string | null;
  readonly resource_id: string | null;
  readonly environment: string | null;
  readonly consumed_unit: string;
  readonly currency: string;
  readonly metric_count: number;
  readonly consumed_quantity: number;
  readonly total_cost: number;
}

export interface TopUsageRow {
  readonly service_name: string;
  readonly provider: string;
  readonly consumed_unit: string;
  readonly currency: string;
  readonly metric_count: number;
  readonly consumed_quantity: number;
  readonly total_cost: number;
}

/**
 * Mapea una fila de agregación por proveedor al item de dominio
 * {@link CostAnalyticsProviderItem}. Los importes ya vienen como `number`
 * (casteados a `float8` en SQL).
 */
export function toProviderItem(row: ProviderRow): CostAnalyticsProviderItem {
  return {
    provider: row.provider,
    totalCost: row.total_cost,
    metricCount: row.metric_count,
  };
}

/**
 * Mapea una fila de agregación por cuenta al item de dominio
 * {@link CostAnalyticsAccountItem} (incluye el nombre legible de la cuenta).
 */
export function toAccountItem(row: AccountRow): CostAnalyticsAccountItem {
  return {
    cloudAccountId: row.cloud_account_id,
    provider: row.provider,
    name: row.name,
    totalCost: row.total_cost,
    metricCount: row.metric_count,
  };
}

/**
 * Mapea una fila de agregación por servicio al item de dominio
 * {@link CostAnalyticsServiceItem}.
 */
export function toServiceItem(row: ServiceRow): CostAnalyticsServiceItem {
  return {
    serviceName: row.service_name,
    provider: row.provider,
    totalCost: row.total_cost,
    metricCount: row.metric_count,
  };
}

/**
 * Mapea una fila de agregación por entorno al item de dominio
 * {@link CostAnalyticsEnvironmentItem} (el entorno proviene de la etiqueta
 * `environment`, con `'unknown'` cuando falta).
 */
export function toEnvironmentItem(row: EnvironmentRow): CostAnalyticsEnvironmentItem {
  return {
    environment: row.environment,
    totalCost: row.total_cost,
    metricCount: row.metric_count,
  };
}

/**
 * Mapea una fila de agregación por recurso al item de dominio
 * {@link CostAnalyticsResourceItem}.
 */
export function toResourceItem(row: ResourceRow): CostAnalyticsResourceItem {
  return {
    resourceId: row.resource_id,
    serviceName: row.service_name,
    provider: row.provider,
    totalCost: row.total_cost,
    metricCount: row.metric_count,
  };
}

/**
 * Mapea una fila de agregación de uso al item de dominio
 * {@link CostAnalyticsUsageItem}.
 *
 * Calcula el coste unitario (`total_cost / consumed_quantity`) solo cuando la
 * cantidad consumida es positiva; en caso contrario lo omite para evitar
 * divisiones por cero.
 */
export function toUsageItem(row: TopUsageRow): CostAnalyticsUsageItem {
  const unitCost = row.consumed_quantity > 0 ? row.total_cost / row.consumed_quantity : undefined;

  return {
    serviceName: row.service_name,
    provider: row.provider,
    consumedQuantity: row.consumed_quantity,
    consumedUnit: row.consumed_unit,
    totalCost: row.total_cost,
    ...(unitCost !== undefined ? { unitCost } : {}),
    currency: row.currency,
    metricCount: row.metric_count,
  };
}

/**
 * Mapea una fila de `cost_anomalies` (Prisma) al modelo de dominio
 * {@link CostAnomaly}.
 *
 * Casos borde: los importes `Decimal` (`baselineCost`, `observedCost`,
 * `deltaAmount`, `deltaPercent`, `zScore`) se convierten a `number` con
 * `Number()`; las fechas se serializan a ISO 8601; los campos anulables
 * (cuenta, proveedor, servicio, recurso, entorno, `zScore`, `evidence`) solo se
 * incluyen cuando no son `null`.
 *
 * @param row Fila de anomalía de Prisma.
 * @returns Anomalía de coste de dominio.
 */
export function toAnomalyDomain(row: Awaited<ReturnType<PrismaClient['costAnomaly']['findFirst']>> & {}): CostAnomaly {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ...(row.cloudAccountId !== null ? { cloudAccountId: row.cloudAccountId } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.serviceName !== null ? { serviceName: row.serviceName } : {}),
    ...(row.resourceId !== null ? { resourceId: row.resourceId } : {}),
    ...(row.environment !== null ? { environment: row.environment } : {}),
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    baselineCost: Number(row.baselineCost),
    observedCost: Number(row.observedCost),
    deltaAmount: Number(row.deltaAmount),
    deltaPercent: Number(row.deltaPercent),
    ...(row.zScore !== null ? { zScore: Number(row.zScore) } : {}),
    severity: row.severity,
    status: row.status,
    explanation: row.explanation,
    ...(row.evidence !== null ? { evidence: row.evidence } : {}),
    detectedAt: row.detectedAt.toISOString(),
  };
}

/**
 * Mapea una fila de `cost_forecasts` (Prisma) al modelo de dominio
 * {@link CostForecast}.
 *
 * Casos borde: los importes `Decimal` (`predictedCost`, `lowerBound`,
 * `upperBound`, `confidence`) se convierten a `number`; las fechas
 * (`forecastMonth`, `generatedAt`) se serializan a ISO 8601; `groupBy` se
 * castea al tipo del dominio; los campos anulables (cuenta, proveedor,
 * servicio, `evidence`) solo se incluyen cuando no son `null`.
 *
 * @param row Fila de pronóstico de Prisma.
 * @returns Pronóstico de coste de dominio.
 */
export function toForecastDomain(row: Awaited<ReturnType<PrismaClient['costForecast']['findFirst']>> & {}): CostForecast {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ...(row.cloudAccountId !== null ? { cloudAccountId: row.cloudAccountId } : {}),
    ...(row.provider !== null ? { provider: row.provider } : {}),
    ...(row.serviceName !== null ? { serviceName: row.serviceName } : {}),
    groupBy: row.groupBy as CostForecast['groupBy'],
    groupKey: row.groupKey,
    forecastMonth: row.forecastMonth.toISOString(),
    predictedCost: Number(row.predictedCost),
    lowerBound: Number(row.lowerBound),
    upperBound: Number(row.upperBound),
    method: row.method,
    confidence: Number(row.confidence),
    currency: row.currency,
    ...(row.evidence !== null ? { evidence: row.evidence } : {}),
    generatedAt: row.generatedAt.toISOString(),
  };
}

/**
 * ═══════════════════════════════════════════════════════════════
 * ICostRepository — Contrato de Persistencia
 * ═══════════════════════════════════════════════════════════════
 *
 * Define el contrato para la capa de persistencia de métricas
 * de costo. Preparado para PostgreSQL + TimescaleDB.
 *
 * @module domain/interfaces
 */

import type { InternalCostMetric } from '../models/InternalCostMetric.js';

/**
 * Criterios de consulta de métricas de costo por rango temporal.
 */
export interface CostMetricQuery {
  readonly tenantId: string;
  /** Filtra por proveedor; opcional. */
  readonly providerName?: string;
  /** Filtra por cuenta cloud; opcional. */
  readonly cloudAccountId?: string;
  /** Inicio del rango temporal a consultar (inclusivo). */
  readonly startDate: Date;
  /** Fin del rango temporal a consultar. */
  readonly endDate: Date;
}

export interface CostDataOptions {
  readonly periods: readonly { readonly period: string; readonly metricCount: number }[];
  readonly latestPeriod?: string;
  readonly cloudAccounts: readonly { readonly id: string; readonly name: string; readonly provider: string }[];
  readonly services: readonly string[];
  readonly regions: readonly string[];
  readonly currencies: readonly string[];
}

export type CostHistoryGranularity = 'day' | 'month';
export type CostHistoryRangeMode = 'CALENDAR' | 'LATEST_AVAILABLE';

export interface CostHistoryQuery {
  readonly tenantId: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly reportingCurrency: string;
  readonly granularity: CostHistoryGranularity;
}

export interface CostHistoryNativeTotal {
  readonly currency: string;
  readonly amount: number;
}

export interface CostHistoryPoint {
  readonly periodStart: Date;
  readonly amount: number | null;
  readonly nativeTotals: readonly CostHistoryNativeTotal[];
  readonly metricCount: number;
  readonly conversionStatus: 'NOT_REQUIRED' | 'CONVERTED' | 'MISSING_RATE' | 'UNSUPPORTED_CURRENCY';
  readonly conversionRate?: number;
  readonly rateSource?: string;
}

export interface CostHistoryResult {
  readonly reportingCurrency: string;
  readonly points: readonly CostHistoryPoint[];
  readonly totalsByCurrency: readonly CostHistoryNativeTotal[];
  readonly coverage: {
    readonly firstPeriod: Date | null;
    readonly lastPeriod: Date | null;
    readonly periodsWithData: number;
    readonly expectedPeriods: number;
    readonly missingPeriods: number;
    readonly conversionIssuePeriods: number;
  };
}

/**
 * Contrato de repositorio para persistencia de métricas de costo.
 *
 * Siguiendo el principio DIP, las capas de aplicación dependen
 * de esta abstracción, no de la implementación concreta de PostgreSQL.
 */
export interface ICostRepository {
  /**
   * Consulta métricas de costo por rango de fechas y proveedor.
   *
   * @param query - Alcance tenant/cuenta/proveedor y rango temporal.
   * @returns            - Arreglo de métricas dentro del rango.
   */
  findByDateRange(query: CostMetricQuery): Promise<InternalCostMetric[]>;

  getDataOptions(tenantId: string, period?: string): Promise<CostDataOptions>;

  getReportingCurrency(tenantId: string): Promise<string>;

  /** Returns the latest cost period available for a tenant, if any. */
  getLatestCostPeriod(tenantId: string): Promise<Date | null>;

  getCostHistory(query: CostHistoryQuery): Promise<CostHistoryResult>;
}

import type {
  CostDataOptions,
  CostHistoryPoint,
  CostHistoryQuery,
  CostHistoryResult,
  CostMetricQuery,
  ICostRepository,
} from '../../domain/interfaces/ICostRepository.js';
import type { FxRateRecord, IFxRateRepository } from '../../domain/interfaces/IFxRateRepository.js';
import type { IFxRateProvider } from '../../domain/interfaces/IFxRateProvider.js';
import type { InternalCostMetric } from '../../domain/models/InternalCostMetric.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { CloudProvider } from '../../generated/prisma/client.js';

interface CostHistoryRow {
  readonly period: Date;
  readonly currency: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

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
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fxRateRepository?: IFxRateRepository,
    private readonly fxRateProvider?: IFxRateProvider,
  ) {}

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

  public async getReportingCurrency(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { reportingCurrency: true } });
    return normalizeCurrency(tenant?.reportingCurrency ?? 'USD');
  }

  public async getLatestCostPeriod(tenantId: string): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<readonly { latest_period: Date | null }[]>`
      SELECT MAX(charge_period_start)::timestamptz AS latest_period
      FROM cost_metrics
      WHERE tenant_id = ${tenantId}
    `;
    return row?.latest_period ?? null;
  }

  public async getCostHistory(query: CostHistoryQuery): Promise<CostHistoryResult> {
    const rows = await this.prisma.$queryRaw<CostHistoryRow[]>`
      SELECT date_trunc('day', charge_period_start)::timestamptz AS period,
             billing_currency AS currency,
             COUNT(*)::int AS metric_count,
             COALESCE(SUM(billed_cost), 0)::float8 AS total_cost
      FROM cost_metrics
      WHERE tenant_id = ${query.tenantId}
        AND charge_period_start >= ${query.startDate}
        AND charge_period_start < ${query.endDate}
      GROUP BY date_trunc('day', charge_period_start), billing_currency
      ORDER BY period ASC, currency ASC
    `;

    const normalizedReportingCurrency = normalizeCurrency(query.reportingCurrency);
    const nativeTotals = sumNativeTotals(rows);
    const rates = await this.loadRates(rows, query.startDate, query.endDate, normalizedReportingCurrency);
    const convertedByDay = new Map<string, CostHistoryPoint>();

    for (const row of rows) {
      const periodStart = startOfUtcDay(row.period);
      const key = periodStart.toISOString();
      const existing = convertedByDay.get(key);
      const nativeForPeriod = existing?.nativeTotals ?? [];
      const nativeTotalsForPeriod = addNativeTotal(nativeForPeriod, row.currency, Number(row.total_cost));
      const conversion = convertAmount(
        Number(row.total_cost),
        normalizeCurrency(row.currency),
        normalizedReportingCurrency,
        periodStart,
        rates,
      );
      const previousAmount = existing?.amount ?? 0;
      const amount = existing?.conversionStatus === 'MISSING_RATE' || existing?.conversionStatus === 'UNSUPPORTED_CURRENCY'
        ? null
        : conversion.amount === null ? null : previousAmount + conversion.amount;
      const status = mergeConversionStatus(existing?.conversionStatus, conversion.status);

      convertedByDay.set(key, {
        periodStart,
        amount,
        nativeTotals: nativeTotalsForPeriod,
        metricCount: (existing?.metricCount ?? 0) + Number(row.metric_count),
        conversionStatus: status,
        ...(status === 'CONVERTED' && conversion.rate === undefined ? {} : conversion.rate === undefined ? {} : { conversionRate: conversion.rate }),
        ...(conversion.source === undefined ? {} : { rateSource: conversion.source }),
      });
    }

    const points = buildCompletePeriods(query, convertedByDay);
    return {
      reportingCurrency: normalizedReportingCurrency,
      points,
      totalsByCurrency: nativeTotals,
      coverage: {
        firstPeriod: points.find((point) => point.nativeTotals.length > 0)?.periodStart ?? null,
        lastPeriod: [...points].reverse().find((point) => point.nativeTotals.length > 0)?.periodStart ?? null,
        periodsWithData: points.filter((point) => point.nativeTotals.length > 0).length,
        expectedPeriods: points.length,
        missingPeriods: points.filter((point) => point.nativeTotals.length === 0).length,
        conversionIssuePeriods: points.filter((point) => point.conversionStatus === 'MISSING_RATE' || point.conversionStatus === 'UNSUPPORTED_CURRENCY').length,
      },
    };
  }

  private async loadRates(
    rows: readonly CostHistoryRow[],
    from: Date,
    to: Date,
    reportingCurrency: string,
  ): Promise<readonly FxRateRecord[]> {
    const currencies = [...new Set(rows.map((row) => normalizeCurrency(row.currency)))].filter((currency) => currency !== reportingCurrency);
    if (currencies.length === 0 || this.fxRateRepository === undefined) return [];

    const allRates: FxRateRecord[] = [];
    for (const currency of currencies) {
      const direct = await this.fxRateRepository.findRates({
        baseCurrency: currency,
        quoteCurrency: reportingCurrency,
        from: addUtcDays(from, -7),
        to,
      });
      if (direct.length > 0) {
        allRates.push(...direct);
        continue;
      }

      if (this.fxRateProvider !== undefined && isUsdCopPair(currency, reportingCurrency)) {
        try {
          const fetched = await this.fxRateProvider.loadUsdCopRates(addUtcDays(from, -7), to);
          if (fetched.length > 0) {
            await this.fxRateRepository.upsertRates(fetched);
            allRates.push(...fetched.filter((rate) => rate.baseCurrency === currency && rate.quoteCurrency === reportingCurrency));
          }
        } catch {
          // A provider outage must not break the dashboard. The response will
          // mark affected points as MISSING_RATE and preserve native totals.
        }
      }
    }
    return allRates;
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

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase().slice(0, 3) || 'USD';
}

function normalizeRowsNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function sumNativeTotals(rows: readonly CostHistoryRow[]): readonly { readonly currency: string; readonly amount: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const currency = normalizeCurrency(row.currency);
    totals.set(currency, (totals.get(currency) ?? 0) + normalizeRowsNumber(Number(row.total_cost)));
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, amount]) => ({ currency, amount }));
}

function addNativeTotal(
  totals: readonly { readonly currency: string; readonly amount: number }[],
  currency: string,
  amount: number,
): readonly { readonly currency: string; readonly amount: number }[] {
  const next = new Map(totals.map((item) => [item.currency, item.amount]));
  next.set(currency, (next.get(currency) ?? 0) + amount);
  return [...next.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([itemCurrency, itemAmount]) => ({ currency: itemCurrency, amount: itemAmount }));
}

function convertAmount(
  amount: number,
  sourceCurrency: string,
  reportingCurrency: string,
  period: Date,
  rates: readonly FxRateRecord[],
): { readonly amount: number | null; readonly status: CostHistoryPoint['conversionStatus']; readonly rate?: number; readonly source?: string } {
  if (sourceCurrency === reportingCurrency) return { amount, status: 'NOT_REQUIRED' };
  const rate = [...rates]
    .filter((candidate) => candidate.baseCurrency === sourceCurrency && candidate.quoteCurrency === reportingCurrency)
    .filter((candidate) => candidate.validFrom.getTime() <= period.getTime())
    .filter((candidate) => candidate.validTo === null || candidate.validTo.getTime() >= period.getTime())
    .sort((left, right) => right.validFrom.getTime() - left.validFrom.getTime())[0];
  if (rate === undefined) {
    return { amount: null, status: isSupportedCurrency(sourceCurrency, reportingCurrency) ? 'MISSING_RATE' : 'UNSUPPORTED_CURRENCY' };
  }
  return { amount: amount * rate.rate, status: 'CONVERTED', rate: rate.rate, source: rate.source };
}

function mergeConversionStatus(
  existing: CostHistoryPoint['conversionStatus'] | undefined,
  current: CostHistoryPoint['conversionStatus'],
): CostHistoryPoint['conversionStatus'] {
  if (existing === 'MISSING_RATE' || current === 'MISSING_RATE') return 'MISSING_RATE';
  if (existing === 'UNSUPPORTED_CURRENCY' || current === 'UNSUPPORTED_CURRENCY') return 'UNSUPPORTED_CURRENCY';
  if (existing === 'CONVERTED' || current === 'CONVERTED') return 'CONVERTED';
  return 'NOT_REQUIRED';
}

function buildCompletePeriods(query: CostHistoryQuery, byDay: ReadonlyMap<string, CostHistoryPoint>): readonly CostHistoryPoint[] {
  const points: CostHistoryPoint[] = [];
  const first = startOfUtcDay(query.startDate);
  const last = startOfUtcDay(new Date(query.endDate.getTime() - 1));
  for (let cursor = first; cursor.getTime() <= last.getTime(); cursor = addUtcDays(cursor, 1)) {
    const day = byDay.get(cursor.toISOString());
    if (query.granularity === 'day') {
      points.push(day ?? { periodStart: cursor, amount: null, nativeTotals: [], metricCount: 0, conversionStatus: 'NOT_REQUIRED' });
    }
  }
  if (query.granularity === 'month') {
    const months = new Map<string, CostHistoryPoint>();
    for (const day of [...byDay.values()]) {
      const month = new Date(Date.UTC(day.periodStart.getUTCFullYear(), day.periodStart.getUTCMonth(), 1));
      const key = month.toISOString();
      const current = months.get(key);
      const nativeTotals = current === undefined ? day.nativeTotals : mergeNativeTotals(current.nativeTotals, day.nativeTotals);
      months.set(key, {
        periodStart: month,
        amount: current?.amount === null || day.amount === null ? null : (current?.amount ?? 0) + day.amount,
        nativeTotals,
        metricCount: (current?.metricCount ?? 0) + day.metricCount,
        conversionStatus: mergeConversionStatus(current?.conversionStatus, day.conversionStatus),
        ...(day.conversionRate === undefined ? {} : { conversionRate: day.conversionRate }),
        ...(day.rateSource === undefined ? {} : { rateSource: day.rateSource }),
      });
    }
    const firstMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    const lastMonth = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1));
    for (let cursor = firstMonth; cursor.getTime() <= lastMonth.getTime(); cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) {
      points.push(months.get(cursor.toISOString()) ?? { periodStart: cursor, amount: null, nativeTotals: [], metricCount: 0, conversionStatus: 'NOT_REQUIRED' });
    }
  }
  return points;
}

function mergeNativeTotals(
  left: readonly { readonly currency: string; readonly amount: number }[],
  right: readonly { readonly currency: string; readonly amount: number }[],
): readonly { readonly currency: string; readonly amount: number }[] {
  const merged = new Map(left.map((item) => [item.currency, item.amount]));
  for (const item of right) merged.set(item.currency, (merged.get(item.currency) ?? 0) + item.amount);
  return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount }));
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function isUsdCopPair(left: string, right: string): boolean {
  return (left === 'USD' && right === 'COP') || (left === 'COP' && right === 'USD');
}

function isSupportedCurrency(left: string, right: string): boolean {
  return isUsdCopPair(left, right);
}

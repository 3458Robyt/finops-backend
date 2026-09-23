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
import { CurrencyConverter, normalizeCurrencyCode } from '../finance/CurrencyConverter.js';
import {
  addNativeTotal,
  addUtcDays,
  buildCompletePeriods,
  convertAmount,
  isUsdCopPair,
  mergeConversionStatus,
  normalizeCurrency,
  sumNativeTotals,
  type CostHistoryRow,
} from './queries/costHistorySupport.js';

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
    private readonly currencyConverter = fxRateRepository === undefined
      ? undefined
      : new CurrencyConverter(fxRateRepository, fxRateProvider),
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

    const metrics = rows.map((row) => ({
      resourceId: row.resourceId,
      service: row.serviceName,
      amount: Number(row.billedCost),
      currency: row.billingCurrency,
      ...(row.consumedQuantity !== null ? { usage: Number(row.consumedQuantity) } : {}),
      ...(row.consumedUnit !== null ? { usageUnit: row.consumedUnit } : {}),
      timestamp: row.chargePeriodStart,
      tags: this.toStringRecord(row.tags),
    }));
    if (this.currencyConverter === undefined || metrics.length === 0) return metrics;
    const reportingCurrency = await this.getReportingCurrency(query.tenantId);
    const projections = await this.currencyConverter.convertMany(
      metrics.map((metric) => ({ amount: metric.amount, currency: metric.currency, at: metric.timestamp })),
      reportingCurrency,
    );
    return metrics.map((metric, index) => ({
      ...metric,
      reportingAmount: projections[index]!.amount,
      reportingCurrency: normalizeCurrencyCode(reportingCurrency),
      conversionStatus: projections[index]!.status,
    }));
  }

  public async getDataOptions(tenantId: string, period?: string): Promise<CostDataOptions> {
    const [periodRows, reportingCurrency] = await Promise.all([
      this.prisma.$queryRaw<readonly { period: Date; metric_count: bigint }[]>`
        SELECT date_trunc('month', charge_period_start) AS period, COUNT(*)::bigint AS metric_count
        FROM cost_metrics
        WHERE tenant_id = ${tenantId}
        GROUP BY date_trunc('month', charge_period_start)
        ORDER BY period DESC
      `,
      this.getReportingCurrency(tenantId),
    ]);
    const periods = periodRows.map((row) => ({ period: row.period.toISOString().slice(0, 7), metricCount: Number(row.metric_count) }));
    const selectedPeriod = period ?? periods[0]?.period;
    if (selectedPeriod === undefined) return { reportingCurrency, periods, cloudAccounts: [], services: [], regions: [], currencies: [] };
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
      reportingCurrency,
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
    const [row] = await this.prisma.$queryRaw<readonly { latest_period_utc: string | null }[]>`
      SELECT to_char(MAX(charge_period_start) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS latest_period_utc
      FROM cost_metrics
      WHERE tenant_id = ${tenantId}
    `;
    return row?.latest_period_utc === null || row?.latest_period_utc === undefined
      ? null
      : new Date(row.latest_period_utc);
  }

  public async getCostHistory(query: CostHistoryQuery): Promise<CostHistoryResult> {
    const rows = await this.prisma.$queryRaw<CostHistoryRow[]>`
      SELECT to_char(date_trunc('day', charge_period_start AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS period_utc,
             billing_currency AS currency,
             COUNT(*)::int AS metric_count,
             COALESCE(SUM(billed_cost), 0)::float8 AS total_cost
      FROM cost_metrics
      WHERE tenant_id = ${query.tenantId}
        AND charge_period_start >= ${query.startDate.toISOString()}::timestamptz
        AND charge_period_start < ${query.endDate.toISOString()}::timestamptz
      GROUP BY date_trunc('day', charge_period_start AT TIME ZONE 'UTC'), billing_currency
      ORDER BY period_utc ASC, currency ASC
    `;

    const normalizedReportingCurrency = normalizeCurrency(query.reportingCurrency);
    const nativeTotals = sumNativeTotals(rows);
    const rates = await this.loadRates(rows, query.startDate, query.endDate, normalizedReportingCurrency);
    const convertedByDay = new Map<string, CostHistoryPoint>();

    for (const row of rows) {
      const periodStart = new Date(`${row.period_utc}T00:00:00.000Z`);
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

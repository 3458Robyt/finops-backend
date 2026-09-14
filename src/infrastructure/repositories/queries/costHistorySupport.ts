import type { CostHistoryPoint, CostHistoryQuery } from '../../../domain/interfaces/ICostRepository.js';
import type { FxRateRecord } from '../../../domain/interfaces/IFxRateRepository.js';

export interface CostHistoryRow {
  readonly period: Date;
  readonly currency: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

export function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase().slice(0, 3) || 'USD';
}

export function normalizeRowsNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function sumNativeTotals(rows: readonly CostHistoryRow[]): readonly { readonly currency: string; readonly amount: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const currency = normalizeCurrency(row.currency);
    totals.set(currency, (totals.get(currency) ?? 0) + normalizeRowsNumber(Number(row.total_cost)));
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, amount]) => ({ currency, amount }));
}

export function addNativeTotal(
  totals: readonly { readonly currency: string; readonly amount: number }[],
  currency: string,
  amount: number,
): readonly { readonly currency: string; readonly amount: number }[] {
  const next = new Map(totals.map((item) => [item.currency, item.amount]));
  next.set(currency, (next.get(currency) ?? 0) + amount);
  return [...next.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([itemCurrency, itemAmount]) => ({ currency: itemCurrency, amount: itemAmount }));
}

export function convertAmount(
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

export function mergeConversionStatus(
  existing: CostHistoryPoint['conversionStatus'] | undefined,
  current: CostHistoryPoint['conversionStatus'],
): CostHistoryPoint['conversionStatus'] {
  if (existing === 'MISSING_RATE' || current === 'MISSING_RATE') return 'MISSING_RATE';
  if (existing === 'UNSUPPORTED_CURRENCY' || current === 'UNSUPPORTED_CURRENCY') return 'UNSUPPORTED_CURRENCY';
  if (existing === 'CONVERTED' || current === 'CONVERTED') return 'CONVERTED';
  return 'NOT_REQUIRED';
}

export function buildCompletePeriods(query: CostHistoryQuery, byDay: ReadonlyMap<string, CostHistoryPoint>): readonly CostHistoryPoint[] {
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

export function mergeNativeTotals(
  left: readonly { readonly currency: string; readonly amount: number }[],
  right: readonly { readonly currency: string; readonly amount: number }[],
): readonly { readonly currency: string; readonly amount: number }[] {
  const merged = new Map(left.map((item) => [item.currency, item.amount]));
  for (const item of right) merged.set(item.currency, (merged.get(item.currency) ?? 0) + item.amount);
  return [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount }));
}

export function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isUsdCopPair(left: string, right: string): boolean {
  return (left === 'USD' && right === 'COP') || (left === 'COP' && right === 'USD');
}

function isSupportedCurrency(left: string, right: string): boolean {
  return isUsdCopPair(left, right);
}

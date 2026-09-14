import type { FxRateRecord, IFxRateRepository } from '../../domain/interfaces/IFxRateRepository.js';
import type { IFxRateProvider } from '../../domain/interfaces/IFxRateProvider.js';

export type CurrencyConversionStatus = 'NOT_REQUIRED' | 'CONVERTED' | 'MISSING_RATE' | 'UNSUPPORTED_CURRENCY';

export interface CurrencyAmountInput {
  readonly amount: number;
  readonly currency: string;
  readonly at: Date;
}

export interface CurrencyAmountProjection {
  readonly amount: number | null;
  readonly currency: string;
  readonly sourceCurrency: string;
  readonly status: CurrencyConversionStatus;
  readonly rate?: number;
  readonly source?: string;
}

interface CachedRates {
  readonly expiresAt: number;
  readonly rates: readonly FxRateRecord[];
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 32;

/**
 * Projects native cloud charges into the tenant reporting currency.
 * Native values are never mutated; an unavailable rate becomes null instead
 * of silently being treated as zero.
 */
export class CurrencyConverter {
  private readonly ratesCache = new Map<string, CachedRates>();

  public constructor(
    private readonly rateRepository?: IFxRateRepository,
    private readonly rateProvider?: IFxRateProvider,
  ) {}

  public async convertMany(
    values: readonly CurrencyAmountInput[],
    reportingCurrency: string,
  ): Promise<readonly CurrencyAmountProjection[]> {
    const target = normalizeCurrencyCode(reportingCurrency);
    const normalizedValues = values.map((value) => ({
      ...value,
      amount: Number.isFinite(value.amount) ? value.amount : 0,
      currency: normalizeCurrencyCode(value.currency),
    }));
    const rates = await this.loadRates(normalizedValues, target);

    return normalizedValues.map((value) => {
      if (value.currency === target) {
        return { amount: value.amount, currency: target, sourceCurrency: value.currency, status: 'NOT_REQUIRED' };
      }
      const rate = selectRate(rates, value.currency, target, value.at);
      if (rate === undefined) {
        return {
          amount: null,
          currency: target,
          sourceCurrency: value.currency,
          status: isSupportedPair(value.currency, target) ? 'MISSING_RATE' : 'UNSUPPORTED_CURRENCY',
        };
      }
      return {
        amount: value.amount * rate.rate,
        currency: target,
        sourceCurrency: value.currency,
        status: 'CONVERTED',
        rate: rate.rate,
        source: rate.source,
      };
    });
  }

  private async loadRates(
    values: readonly CurrencyAmountInput[],
    target: string,
  ): Promise<readonly FxRateRecord[]> {
    const sourceCurrencies = [...new Set(values.map((value) => value.currency))]
      .filter((currency) => currency !== target && isSupportedPair(currency, target));
    if (sourceCurrencies.length === 0 || this.rateRepository === undefined) return [];

    const from = new Date(Math.min(...values.map((value) => value.at.getTime())) - 7 * 24 * 60 * 60 * 1000);
    const to = new Date(Math.max(...values.map((value) => value.at.getTime())) + 24 * 60 * 60 * 1000);
    const allRates: FxRateRecord[] = [];
    for (const source of sourceCurrencies) {
      allRates.push(...await this.loadPairRates(source, target, from, to));
    }
    return allRates;
  }

  private async loadPairRates(
    source: string,
    target: string,
    from: Date,
    to: Date,
  ): Promise<readonly FxRateRecord[]> {
    const key = `${source}:${target}:${from.toISOString().slice(0, 10)}:${to.toISOString().slice(0, 10)}`;
    const cached = this.ratesCache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.rates;

    const repository = this.rateRepository;
    if (repository === undefined) return [];
    let rates = [...await repository.findRates({ baseCurrency: source, quoteCurrency: target, from, to })];
    if (rates.length === 0) {
      const inverse = await repository.findRates({ baseCurrency: target, quoteCurrency: source, from, to });
      rates = inverse.map((rate) => ({
        ...rate,
        baseCurrency: source,
        quoteCurrency: target,
        rate: 1 / rate.rate,
      }));
    }

    if (rates.length === 0 && this.rateProvider !== undefined) {
      try {
        const fetched = await this.rateProvider.loadUsdCopRates(from, to);
        if (fetched.length > 0) {
          await repository.upsertRates(fetched);
          rates = fetched.filter((rate) => rate.baseCurrency === source && rate.quoteCurrency === target);
          if (rates.length === 0) {
            rates = fetched
              .filter((rate) => rate.baseCurrency === target && rate.quoteCurrency === source)
              .map((rate) => ({ ...rate, baseCurrency: source, quoteCurrency: target, rate: 1 / rate.rate }));
          }
        }
      } catch {
        // The caller receives MISSING_RATE while native amounts remain visible.
      }
    }

    if (this.ratesCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.ratesCache.keys().next().value;
      if (oldest !== undefined) this.ratesCache.delete(oldest);
    }
    this.ratesCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, rates });
    return rates;
  }
}

function selectRate(
  rates: readonly FxRateRecord[],
  source: string,
  target: string,
  at: Date,
): FxRateRecord | undefined {
  return rates
    .filter((rate) => rate.baseCurrency === source && rate.quoteCurrency === target)
    .filter((rate) => rate.validFrom.getTime() <= at.getTime())
    .filter((rate) => rate.validTo === null || rate.validTo.getTime() >= at.getTime())
    .sort((left, right) => right.validFrom.getTime() - left.validFrom.getTime())[0];
}

export function normalizeCurrencyCode(value: string): string {
  return value.trim().toUpperCase().slice(0, 3) || 'USD';
}

function isSupportedPair(left: string, right: string): boolean {
  return (left === 'USD' && right === 'COP') || (left === 'COP' && right === 'USD');
}

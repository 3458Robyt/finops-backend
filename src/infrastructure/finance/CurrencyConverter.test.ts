import { describe, expect, it, vi } from 'vitest';
import type { FxRateRecord, IFxRateRepository } from '../../domain/interfaces/IFxRateRepository.js';
import { CurrencyConverter } from './CurrencyConverter.js';

const at = new Date('2026-09-01T00:00:00.000Z');

describe('CurrencyConverter', () => {
  it('converts a native amount with a direct database rate', async () => {
    const repository = new FakeRateRepository([rate('USD', 'COP', 4000)]);
    const converter = new CurrencyConverter(repository);

    await expect(converter.convertMany([{ amount: 2.5, currency: 'USD', at }], 'COP')).resolves.toEqual([
      expect.objectContaining({ amount: 10_000, currency: 'COP', sourceCurrency: 'USD', status: 'CONVERTED', rate: 4000 }),
    ]);
  });

  it('uses the inverse rate when the direct pair is not stored', async () => {
    const repository = new FakeRateRepository([rate('COP', 'USD', 0.00025)]);
    const converter = new CurrencyConverter(repository);

    await expect(converter.convertMany([{ amount: 2, currency: 'USD', at }], 'COP')).resolves.toEqual([
      expect.objectContaining({ amount: 8_000, currency: 'COP', sourceCurrency: 'USD', status: 'CONVERTED', rate: 4000 }),
    ]);
  });

  it('returns a visible missing-rate status instead of fabricating zero', async () => {
    const repository = new FakeRateRepository([]);
    const converter = new CurrencyConverter(repository);

    await expect(converter.convertMany([{ amount: 12, currency: 'USD', at }], 'COP')).resolves.toEqual([
      { amount: null, currency: 'COP', sourceCurrency: 'USD', status: 'MISSING_RATE' },
    ]);
  });
});

function rate(baseCurrency: string, quoteCurrency: string, value: number): FxRateRecord {
  return {
    baseCurrency,
    quoteCurrency,
    rate: value,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validTo: null,
    source: 'TEST',
    retrievedAt: at,
  };
}

class FakeRateRepository implements IFxRateRepository {
  public readonly findRates = vi.fn(async (input: { readonly baseCurrency: string; readonly quoteCurrency: string }) =>
    this.rates.filter((item) => item.baseCurrency === input.baseCurrency && item.quoteCurrency === input.quoteCurrency));

  public constructor(private readonly rates: readonly FxRateRecord[]) {}

  public async upsertRates(): Promise<void> {}
}

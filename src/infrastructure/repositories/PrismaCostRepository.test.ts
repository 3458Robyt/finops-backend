import { describe, expect, it } from 'vitest';
import type { IFxRateRepository, FxRateRecord } from '../../domain/interfaces/IFxRateRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaCostRepository } from './PrismaCostRepository.js';

describe('PrismaCostRepository.getCostHistory', () => {
  it('converts native COP amounts, preserves native totals and leaves empty days as gaps', async () => {
    const rate: FxRateRecord = {
      baseCurrency: 'COP',
      quoteCurrency: 'USD',
      rate: 0.0003066,
      validFrom: new Date('2026-07-19T00:00:00.000Z'),
      validTo: new Date('2026-07-19T00:00:00.000Z'),
      source: 'official-trm',
      sourceUrl: 'https://example.test/trm',
      retrievedAt: new Date('2026-07-20T00:00:00.000Z'),
    };
    const repository = createRepository([
      row('2026-07-19', 'COP', 2_161_861.24),
      row('2026-07-21', 'COP', 6_698.22),
    ], [rate]);

    const result = await repository.getCostHistory({
      tenantId: 'tenant-1',
      startDate: new Date('2026-07-19T00:00:00.000Z'),
      endDate: new Date('2026-07-22T00:00:00.000Z'),
      reportingCurrency: 'USD',
      granularity: 'day',
    });

    expect(result.points).toHaveLength(3);
    expect(result.points[0]?.conversionStatus).toBe('CONVERTED');
    expect(result.points[0]?.amount).toBeCloseTo(662.83, 1);
    expect(result.points[1]?.amount).toBeNull();
    expect(result.points[1]?.nativeTotals).toEqual([]);
    expect(result.points[2]?.nativeTotals).toEqual([{ currency: 'COP', amount: 6698.22 }]);
    expect(result.totalsByCurrency[0]?.currency).toBe('COP');
    expect(result.totalsByCurrency[0]?.amount).toBeCloseTo(2_168_559.46, 2);
    expect(result.coverage).toMatchObject({ expectedPeriods: 3, periodsWithData: 2, missingPeriods: 1, conversionIssuePeriods: 1 });
  });

  it('marks a period as missing-rate without failing the history request', async () => {
    const repository = createRepository([row('2026-07-19', 'EUR', 100)], []);

    const result = await repository.getCostHistory({
      tenantId: 'tenant-1',
      startDate: new Date('2026-07-19T00:00:00.000Z'),
      endDate: new Date('2026-07-20T00:00:00.000Z'),
      reportingCurrency: 'USD',
      granularity: 'day',
    });

    expect(result.points[0]).toMatchObject({ amount: null, conversionStatus: 'UNSUPPORTED_CURRENCY' });
    expect(result.totalsByCurrency).toEqual([{ currency: 'EUR', amount: 100 }]);
    expect(result.coverage.conversionIssuePeriods).toBe(1);
  });

  it('aggregates converted daily values into monthly periods', async () => {
    const repository = createRepository([
      row('2026-07-01', 'USD', 10),
      row('2026-07-15', 'USD', 20),
      row('2026-08-01', 'USD', 5),
    ], []);

    const result = await repository.getCostHistory({
      tenantId: 'tenant-1',
      startDate: new Date('2026-07-01T00:00:00.000Z'),
      endDate: new Date('2026-09-01T00:00:00.000Z'),
      reportingCurrency: 'USD',
      granularity: 'month',
    });

    expect(result.points).toHaveLength(2);
    expect(result.points.map((point) => point.amount)).toEqual([30, 5]);
    expect(result.points.map((point) => point.periodStart.toISOString())).toEqual([
      '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
    ]);
  });
});

function createRepository(rows: readonly CostHistoryRowFixture[], rates: readonly FxRateRecord[]): PrismaCostRepository {
  const prisma = {
    $queryRaw: async () => rows,
  } as unknown as PrismaClient;
  const fxRates: IFxRateRepository = {
    findRates: async () => rates,
    upsertRates: async () => undefined,
  };
  return new PrismaCostRepository(prisma, fxRates);
}

interface CostHistoryRowFixture {
  readonly period: Date;
  readonly currency: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

function row(date: string, currency: string, totalCost: number): CostHistoryRowFixture {
  return { period: new Date(`${date}T00:00:00.000Z`), currency, metric_count: 1, total_cost: totalCost };
}

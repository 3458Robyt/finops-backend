import { describe, expect, it } from 'vitest';
import type { IFxRateRepository, FxRateRecord } from '../../domain/interfaces/IFxRateRepository.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaCostRepository } from './PrismaCostRepository.js';

describe('PrismaCostRepository.getDataOptions', () => {
  it('returns the reporting currency even when the tenant has no cost periods', async () => {
    const repository = createOptionsRepository({ reportingCurrency: 'COP', periodRows: [] });

    await expect(repository.getDataOptions('tenant-1')).resolves.toEqual({
      reportingCurrency: 'COP',
      periods: [],
      cloudAccounts: [],
      services: [],
      regions: [],
      currencies: [],
    });
  });

  it('keeps reporting currency separate from currencies present in the selected cost period', async () => {
    const repository = createOptionsRepository({
      reportingCurrency: 'COP',
      periodRows: [{ period: new Date('2026-09-01T00:00:00.000Z'), metric_count: 2n }],
      dimensions: [{ cloudAccountId: 'account-1', serviceName: 'Compute', regionId: 'sa-bogota-1', billingCurrency: 'USD' }],
      accounts: [{ id: 'account-1', name: 'OCI', provider: 'OCI' }],
    });

    await expect(repository.getDataOptions('tenant-1')).resolves.toMatchObject({
      reportingCurrency: 'COP',
      currencies: ['USD'],
      latestPeriod: '2026-09',
    });
  });
});

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

  it('groups charge periods in UTC instead of the database session timezone', async () => {
    let queryText = '';
    let queryValues: unknown[] = [];
    const prisma = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queryText = Array.from(strings).join('');
        queryValues = values;
        return [];
      },
    } as unknown as PrismaClient;
    const repository = new PrismaCostRepository(prisma);

    await repository.getCostHistory({
      tenantId: 'tenant-1',
      startDate: new Date('2026-06-25T00:00:00.000Z'),
      endDate: new Date('2026-06-26T00:00:00.000Z'),
      reportingCurrency: 'COP',
      granularity: 'day',
    });

    expect(queryText).toContain("charge_period_start AT TIME ZONE 'UTC'");
    expect(queryText.match(/::timestamptz/g)).toHaveLength(2);
    expect(queryValues).toContain('2026-06-25T00:00:00.000Z');
    expect(queryValues).toContain('2026-06-26T00:00:00.000Z');
  });

  it('reads the latest period as an explicit UTC value', async () => {
    let queryText = '';
    const prisma = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        queryText = Array.from(strings).join('');
        return [{ latest_period_utc: '2026-09-22T00:00:00.000Z' }];
      },
    } as unknown as PrismaClient;
    const repository = new PrismaCostRepository(prisma);

    const latest = await repository.getLatestCostPeriod('tenant-1');

    expect(queryText).toContain("MAX(charge_period_start) AT TIME ZONE 'UTC'");
    expect(latest?.toISOString()).toBe('2026-09-22T00:00:00.000Z');
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
  readonly period_utc: string;
  readonly currency: string;
  readonly metric_count: number;
  readonly total_cost: number;
}

function row(date: string, currency: string, totalCost: number): CostHistoryRowFixture {
  return { period_utc: date, currency, metric_count: 1, total_cost: totalCost };
}

function createOptionsRepository(input: {
  readonly reportingCurrency: string;
  readonly periodRows: readonly { readonly period: Date; readonly metric_count: bigint }[];
  readonly dimensions?: readonly { readonly cloudAccountId: string; readonly serviceName: string; readonly regionId: string | null; readonly billingCurrency: string }[];
  readonly accounts?: readonly { readonly id: string; readonly name: string; readonly provider: string }[];
}): PrismaCostRepository {
  const prisma = {
    $queryRaw: async () => input.periodRows,
    tenant: { findUnique: async () => ({ reportingCurrency: input.reportingCurrency }) },
    costMetric: { findMany: async () => input.dimensions ?? [] },
    cloudAccount: { findMany: async () => input.accounts ?? [] },
  } as unknown as PrismaClient;
  return new PrismaCostRepository(prisma);
}

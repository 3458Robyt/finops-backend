import { describe, expect, it, vi } from 'vitest';
import type { FxRateRecord, IFxRateRepository } from '../../../domain/interfaces/IFxRateRepository.js';
import type { MonthlyCostRow, MonthlyUsageRow } from '../mappers/costAnalyticsMappers.js';
import { CurrencyConverter } from '../../finance/CurrencyConverter.js';
import { projectMonthlyCostRows, projectMonthlyUsageRows, projectSnapshotAggregations } from './costAnalyticsCurrencyProjection.js';
import type { SnapshotAggregations } from './costAnalyticsSnapshotQueries.js';

const month = new Date('2026-07-01T00:00:00.000Z');
const dayOne = new Date('2026-07-01T00:00:00.000Z');
const dayTwo = new Date('2026-07-02T00:00:00.000Z');

describe('cost analytics FX projection', () => {
  it('converts each daily cost using the rate effective on that charge date', async () => {
    const converter = createConverter();
    const rows = [dailyCostRow(dayOne), dailyCostRow(dayTwo)] as unknown as MonthlyCostRow[];

    const result = await projectMonthlyCostRows(rows, 'service', 'COP', converter);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ month: month.toISOString(), groupKey: 'Compute', cost: 820_000, currency: 'COP', conversionStatus: 'CONVERTED' });
  });

  it('converts daily cost before deriving monthly unit economics', async () => {
    const converter = createConverter();
    const rows = [dailyUsageRow(dayOne), dailyUsageRow(dayTwo)] as unknown as MonthlyUsageRow[];

    const result = await projectMonthlyUsageRows(rows, 'service', 'COP', converter);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ month: month.toISOString(), cost: 820_000, consumedQuantity: 2, unitCost: 410_000, currency: 'COP' });
  });

  it('converts snapshot totals using each day rate before combining the month', async () => {
    const aggregations = {
      summary: {
        metricCount: 2,
        totalCost: 200,
        byCurrency: [{ currency: 'USD', metricCount: 2, totalCost: 200 }],
        byCurrencyByDay: [
          { currency: 'USD', metricCount: 1, totalCost: 100, conversion_date: dayOne },
          { currency: 'USD', metricCount: 1, totalCost: 100, conversion_date: dayTwo },
        ],
      },
      currencies: [{ currency: 'USD' }],
      providers: [],
      accounts: [],
      services: [],
      environments: [],
      topResources: [],
      topUsage: [],
      observedThrough: dayTwo,
      coveredDays: 2,
    } satisfies SnapshotAggregations;

    const result = await projectSnapshotAggregations(aggregations, 'COP', createConverter());

    expect(result.summary).toMatchObject({ metricCount: 2, totalCost: 820_000, conversionIssueCount: 0 });
    expect(result.summary.byCurrency).toEqual([{ currency: 'COP', metricCount: 2, totalCost: 820_000 }]);
  });

  it('ranks snapshot resources after converting their currencies', async () => {
    const aggregations = {
      ...emptySnapshotAggregations(),
      topResources: [
        ...Array.from({ length: 10 }, (_, index) => resourceRow(`cop-${index}`, 1_000_000, 'COP')),
        resourceRow('usd-resource', 300, 'USD'),
      ],
    } satisfies SnapshotAggregations;

    const result = await projectSnapshotAggregations(aggregations, 'COP', createConverter());

    expect(result.topResources).toHaveLength(10);
    expect(result.topResources[0]).toMatchObject({ resourceId: 'usd-resource', totalCost: 1_260_000, currency: 'COP' });
  });
});

function emptySnapshotAggregations(): SnapshotAggregations {
  return {
    summary: { metricCount: 0, totalCost: 0, byCurrency: [], byCurrencyByDay: [] },
    currencies: [], providers: [], accounts: [], services: [], environments: [], topResources: [], topUsage: [],
    observedThrough: null,
    coveredDays: 0,
  };
}

function resourceRow(resource_id: string, total_cost: number, currency: string) {
  return {
    conversion_date: dayTwo,
    resource_id,
    cloud_account_id: 'account-1',
    cloud_connection_id: null,
    cloud_resource_id: null,
    resource_name: resource_id,
    service_name: 'Compute',
    provider: 'OCI',
    metric_count: 1,
    total_cost,
    currency,
  };
}

function createConverter(): CurrencyConverter {
  const rates: readonly FxRateRecord[] = [
    rate(dayOne, new Date('2026-07-01T23:59:59.999Z'), 4_000),
    rate(dayTwo, new Date('2026-07-31T23:59:59.999Z'), 4_200),
  ];
  const repository: IFxRateRepository = {
    findRates: vi.fn(async ({ baseCurrency, quoteCurrency }) => rates.filter((item) => item.baseCurrency === baseCurrency && item.quoteCurrency === quoteCurrency)),
    upsertRates: vi.fn(async () => undefined),
  };
  return new CurrencyConverter(repository);
}

function rate(validFrom: Date, validTo: Date, value: number): FxRateRecord {
  return { baseCurrency: 'USD', quoteCurrency: 'COP', rate: value, validFrom, validTo, source: 'TEST', retrievedAt: dayTwo };
}

function dailyCostRow(conversion_date: Date): MonthlyCostRow {
  return {
    month,
    conversion_date,
    group_by: 'service',
    group_key: 'Compute',
    provider: 'OCI',
    cloud_account_id: 'account-1',
    service_name: 'Compute',
    resource_id: null,
    environment: 'production',
    currency: 'USD',
    metric_count: 1,
    total_cost: 100,
  };
}

function dailyUsageRow(conversion_date: Date): MonthlyUsageRow {
  return {
    ...dailyCostRow(conversion_date),
    consumed_unit: 'OCPU-hours',
    consumed_quantity: 1,
  };
}

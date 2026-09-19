import type {
  CostAnalyticsAccountItem,
  CostAnalyticsEnvironmentItem,
  CostAnalyticsProviderItem,
  CostAnalyticsResourceItem,
  CostAnalyticsServiceItem,
  CostAnalyticsUsageItem,
  MonthlyCostPoint,
  MonthlyUsagePoint,
} from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { CurrencyConversionStatus } from '../../finance/CurrencyConverter.js';
import { CurrencyConverter } from '../../finance/CurrencyConverter.js';
import type {
  AccountRow,
  EnvironmentRow,
  MonthlyCostRow,
  MonthlyUsageRow,
  ProviderRow,
  ResourceRow,
  ServiceRow,
  TopUsageRow,
} from '../mappers/costAnalyticsMappers.js';
import type { SnapshotAggregations, SnapshotSummary } from './costAnalyticsSnapshotQueries.js';
import { toUsageItem } from '../mappers/costAnalyticsMappers.js';

interface ProjectedAmount {
  readonly amount: number;
  readonly currency: string;
  readonly status: CurrencyConversionStatus;
  readonly comparable: boolean;
}

export interface ProjectedSnapshotAggregations {
  readonly summary: SnapshotSummary & { readonly conversionIssueCount: number };
  readonly providers: readonly CostAnalyticsProviderItem[];
  readonly accounts: readonly CostAnalyticsAccountItem[];
  readonly services: readonly CostAnalyticsServiceItem[];
  readonly environments: readonly CostAnalyticsEnvironmentItem[];
  readonly topResources: readonly CostAnalyticsResourceItem[];
  readonly topUsage: readonly CostAnalyticsUsageItem[];
}

export async function projectSnapshotAggregations(
  aggregations: SnapshotAggregations,
  periodStart: Date,
  reportingCurrency: string,
  converter?: CurrencyConverter,
): Promise<ProjectedSnapshotAggregations> {
  const summaryProjection = await projectAmounts(
    aggregations.summary.byCurrency.map((row) => ({ amount: row.totalCost, currency: row.currency, at: periodStart })),
    reportingCurrency,
    converter,
  );
  const comparableTotal = summaryProjection
    .filter((item) => item.comparable)
    .reduce((total, item) => total + item.amount, 0);
  const issueCount = summaryProjection.filter((item) => !item.comparable).length;
  const summaryByCurrency = new Map<string, { metricCount: number; totalCost: number }>();
  aggregations.summary.byCurrency.forEach((row, index) => {
    const projected = summaryProjection[index]!;
    const current = summaryByCurrency.get(projected.currency) ?? { metricCount: 0, totalCost: 0 };
    summaryByCurrency.set(projected.currency, {
      metricCount: current.metricCount + row.metricCount,
      totalCost: current.totalCost + projected.amount,
    });
  });

  const [providers, accounts, services, environments, topResources, topUsage] = await Promise.all([
    projectAggregateRows<ProviderRow, CostAnalyticsProviderItem>(aggregations.providers, periodStart, reportingCurrency, converter, (row) => row.provider, (row, amount, currency, status) => ({ provider: row.provider, totalCost: amount, metricCount: row.metric_count, currency, conversionStatus: status })),
    projectAggregateRows<AccountRow, CostAnalyticsAccountItem>(aggregations.accounts, periodStart, reportingCurrency, converter, (row) => `${row.cloud_account_id}:${row.provider}`, (row, amount, currency, status) => ({ cloudAccountId: row.cloud_account_id, provider: row.provider, name: row.name, totalCost: amount, metricCount: row.metric_count, currency, conversionStatus: status })),
    projectAggregateRows<ServiceRow, CostAnalyticsServiceItem>(aggregations.services, periodStart, reportingCurrency, converter, (row) => `${row.service_name}:${row.provider}`, (row, amount, currency, status) => ({ serviceName: row.service_name, provider: row.provider, totalCost: amount, metricCount: row.metric_count, currency, conversionStatus: status })),
    projectAggregateRows<EnvironmentRow, CostAnalyticsEnvironmentItem>(aggregations.environments, periodStart, reportingCurrency, converter, (row) => row.environment, (row, amount, currency, status) => ({ environment: row.environment, totalCost: amount, metricCount: row.metric_count, currency, conversionStatus: status })),
    projectAggregateRows<ResourceRow, CostAnalyticsResourceItem>(aggregations.topResources, periodStart, reportingCurrency, converter, (row) => `${row.resource_id}:${row.cloud_account_id}:${row.service_name}:${row.provider}`, (row, amount, currency, status) => ({ resourceId: row.resource_id, cloudAccountId: row.cloud_account_id, ...(row.cloud_connection_id === null ? {} : { cloudConnectionId: row.cloud_connection_id }), ...(row.cloud_resource_id === null ? {} : { cloudResourceId: row.cloud_resource_id }), ...(row.resource_name === null ? {} : { resourceName: row.resource_name }), serviceName: row.service_name, provider: row.provider, totalCost: amount, metricCount: row.metric_count, currency, conversionStatus: status })),
    projectUsageRows(aggregations.topUsage, periodStart, reportingCurrency, converter),
  ]);

  return {
    summary: {
      metricCount: aggregations.summary.metricCount,
      totalCost: comparableTotal,
      byCurrency: [...summaryByCurrency.entries()].map(([currency, value]) => ({ currency, ...value })),
      conversionIssueCount: issueCount,
    },
    providers,
    accounts,
    services,
    environments,
    topResources,
    topUsage: topUsage.map(toUsageItem),
  };
}

export async function projectMonthlyCostRows(
  rows: readonly MonthlyCostRow[],
  groupBy: MonthlyCostPoint['groupBy'],
  reportingCurrency: string,
  converter?: CurrencyConverter,
): Promise<readonly MonthlyCostPoint[]> {
  const projected = await projectAmounts(rows.map((row) => ({ amount: row.total_cost, currency: row.currency, at: row.month })), reportingCurrency, converter);
  const values = new Map<string, MonthlyCostPoint>();
  rows.forEach((row, index) => {
    const amount = projected[index]!;
    const key = `${row.month.toISOString()}:${row.group_key}:${row.provider ?? ''}:${row.cloud_account_id ?? ''}:${row.service_name ?? ''}:${row.resource_id ?? ''}:${row.environment ?? ''}:${amount.currency}`;
    const current = values.get(key);
    values.set(key, current === undefined ? toMonthlyCostPoint(row, groupBy, amount) : {
      ...current,
      cost: current.cost + amount.amount,
      metricCount: current.metricCount + row.metric_count,
      conversionStatus: mergeStatus(current.conversionStatus, amount.status),
    });
  });
  return [...values.values()].sort((left, right) => left.month.localeCompare(right.month) || right.cost - left.cost);
}

export async function projectMonthlyUsageRows(
  rows: readonly MonthlyUsageRow[],
  groupBy: MonthlyUsagePoint['groupBy'],
  reportingCurrency: string,
  converter?: CurrencyConverter,
): Promise<readonly MonthlyUsagePoint[]> {
  const projected = await projectAmounts(rows.map((row) => ({ amount: row.total_cost, currency: row.currency, at: row.month })), reportingCurrency, converter);
  const values = new Map<string, MonthlyUsagePoint>();
  rows.forEach((row, index) => {
    const amount = projected[index]!;
    const key = `${row.month.toISOString()}:${row.group_key}:${row.provider ?? ''}:${row.cloud_account_id ?? ''}:${row.service_name ?? ''}:${row.resource_id ?? ''}:${row.environment ?? ''}:${row.consumed_unit}:${amount.currency}`;
    const current = values.get(key);
    if (current === undefined) {
      values.set(key, toMonthlyUsagePoint(row, groupBy, amount));
      return;
    }
    const cost = current.cost + amount.amount;
    const consumedQuantity = current.consumedQuantity + row.consumed_quantity;
    values.set(key, {
      ...current,
      cost,
      consumedQuantity,
      ...(consumedQuantity > 0 ? { unitCost: cost / consumedQuantity } : {}),
      metricCount: current.metricCount + row.metric_count,
      conversionStatus: mergeStatus(current.conversionStatus, amount.status),
    });
  });
  return [...values.values()].sort((left, right) => left.month.localeCompare(right.month) || right.cost - left.cost);
}

export function mergeCurrencyStatus(
  ...statuses: readonly CurrencyConversionStatus[]
): CurrencyConversionStatus {
  if (statuses.includes('MISSING_RATE')) return 'MISSING_RATE';
  if (statuses.includes('UNSUPPORTED_CURRENCY')) return 'UNSUPPORTED_CURRENCY';
  if (statuses.includes('CONVERTED')) return 'CONVERTED';
  return 'NOT_REQUIRED';
}

async function projectAggregateRows<TRow extends { readonly currency: string; readonly total_cost: number; readonly metric_count: number }, TItem extends { readonly totalCost: number; readonly metricCount: number; readonly currency?: string; readonly conversionStatus?: CurrencyConversionStatus }>(
  rows: readonly TRow[],
  at: Date,
  reportingCurrency: string,
  converter: CurrencyConverter | undefined,
  groupKey: (row: TRow) => string,
  build: (row: TRow, amount: number, currency: string, status: CurrencyConversionStatus) => TItem,
): Promise<readonly TItem[]> {
  const projected = await projectAmounts(rows.map((row) => ({ amount: row.total_cost, currency: row.currency, at })), reportingCurrency, converter);
  const values = new Map<string, TItem>();
  rows.forEach((row, index) => {
    const amount = projected[index]!;
    const key = `${groupKey(row)}:${amount.currency}`;
    const current = values.get(key);
    if (current === undefined) {
      values.set(key, build(row, amount.amount, amount.currency, amount.status));
      return;
    }
    values.set(key, {
      ...current,
      totalCost: current.totalCost + amount.amount,
      metricCount: current.metricCount + row.metric_count,
      conversionStatus: mergeStatus(current.conversionStatus, amount.status),
    });
  });
  return [...values.values()].sort((left, right) => right.totalCost - left.totalCost);
}

async function projectUsageRows(
  rows: readonly TopUsageRow[],
  at: Date,
  reportingCurrency: string,
  converter: CurrencyConverter | undefined,
): Promise<readonly TopUsageRow[]> {
  const projected = await projectAmounts(rows.map((row) => ({ amount: row.total_cost, currency: row.currency, at })), reportingCurrency, converter);
  const values = new Map<string, TopUsageRow>();
  rows.forEach((row, index) => {
    const amount = projected[index]!;
    const key = `${row.service_name}:${row.provider}:${row.consumed_unit}:${amount.currency}`;
    const current = values.get(key);
    if (current === undefined) {
      values.set(key, { ...row, total_cost: amount.amount, currency: amount.currency });
      return;
    }
    values.set(key, { ...current, total_cost: current.total_cost + amount.amount, consumed_quantity: current.consumed_quantity + row.consumed_quantity, metric_count: current.metric_count + row.metric_count });
  });
  return [...values.values()].sort((left, right) => right.total_cost - left.total_cost);
}

async function projectAmounts(
  values: readonly { readonly amount: number; readonly currency: string; readonly at: Date }[],
  reportingCurrency: string,
  converter?: CurrencyConverter,
): Promise<readonly ProjectedAmount[]> {
  if (converter === undefined) return values.map((value) => ({ amount: value.amount, currency: value.currency, status: 'NOT_REQUIRED', comparable: true }));
  const result = await converter.convertMany(values, reportingCurrency);
  return result.map((item, index) => ({
    amount: item.amount ?? values[index]!.amount,
    currency: item.amount === null ? values[index]!.currency : item.currency,
    status: item.status,
    comparable: item.amount !== null,
  }));
}

function toMonthlyCostPoint(row: MonthlyCostRow, groupBy: MonthlyCostPoint['groupBy'], amount: ProjectedAmount): MonthlyCostPoint {
  return {
    month: row.month.toISOString(),
    groupBy,
    groupKey: amount.comparable ? row.group_key : `${row.group_key} [${row.currency}]`,
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.cloud_account_id === null ? {} : { cloudAccountId: row.cloud_account_id }),
    ...(row.service_name === null ? {} : { serviceName: row.service_name }),
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    ...(row.environment === null ? {} : { environment: row.environment }),
    cost: amount.amount,
    currency: amount.currency,
    metricCount: row.metric_count,
    conversionStatus: amount.status,
    ...(amount.comparable && row.currency !== amount.currency ? { nativeCost: row.total_cost, nativeCurrency: row.currency } : {}),
  };
}

function toMonthlyUsagePoint(row: MonthlyUsageRow, groupBy: MonthlyUsagePoint['groupBy'], amount: ProjectedAmount): MonthlyUsagePoint {
  const cost = amount.amount;
  return {
    month: row.month.toISOString(),
    groupBy,
    groupKey: amount.comparable ? row.group_key : `${row.group_key} [${row.currency}]`,
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.cloud_account_id === null ? {} : { cloudAccountId: row.cloud_account_id }),
    ...(row.service_name === null ? {} : { serviceName: row.service_name }),
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    ...(row.environment === null ? {} : { environment: row.environment }),
    consumedQuantity: row.consumed_quantity,
    consumedUnit: row.consumed_unit,
    cost,
    ...(row.consumed_quantity > 0 ? { unitCost: cost / row.consumed_quantity } : {}),
    currency: amount.currency,
    metricCount: row.metric_count,
    conversionStatus: amount.status,
    ...(amount.comparable && row.currency !== amount.currency ? { nativeCost: row.total_cost, nativeCurrency: row.currency } : {}),
  };
}

function mergeStatus(left: CurrencyConversionStatus | undefined, right: CurrencyConversionStatus): CurrencyConversionStatus {
  if (left === 'MISSING_RATE' || right === 'MISSING_RATE') return 'MISSING_RATE';
  if (left === 'UNSUPPORTED_CURRENCY' || right === 'UNSUPPORTED_CURRENCY') return 'UNSUPPORTED_CURRENCY';
  if (left === 'CONVERTED' || right === 'CONVERTED') return 'CONVERTED';
  return 'NOT_REQUIRED';
}

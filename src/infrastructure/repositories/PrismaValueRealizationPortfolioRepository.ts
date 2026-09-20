import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type {
  IValueRealizationRepository,
  ValueRealizationFilters,
  ValueRealizationSummary,
  ValueRealizationItemsPage,
  ValueRealizationTrendPoint,
  ValueRealizationItem,
} from '../../domain/interfaces/IValueRealizationRepository.js';
import {
  defaultPageSize,
  encodeCursor,
  decodeCursor,
  intValue,
  maxExportPageSize,
  maxPageSize,
  numberValue,
  stringValue,
  toItem,
  type ValueRealizationRow,
} from './valueRealizationRepositorySupport.js';
import { filterWhere, portfolioCte } from './valueRealizationRepositorySql.js';
import { CurrencyConverter, normalizeCurrencyCode, type CurrencyConversionStatus } from '../finance/CurrencyConverter.js';

type ItemAmountKey = 'estimatedMonthlySavings' | 'reportedMonthlySavings' | 'observedSavings' | 'projectedMonthlySavings' | 'verifiedMonthlySavings' | 'costIncreaseMonthlyAmount';
interface AmountValue { readonly key: ItemAmountKey; readonly amount: number; readonly currency: string; readonly at: Date; }
interface ProjectedAmounts { readonly values: readonly number[]; readonly currency: string; readonly status: CurrencyConversionStatus; readonly hasIssue: boolean; }

export class PrismaValueRealizationPortfolioRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly currencyConverter?: CurrencyConverter,
  ) {}

  public async getSummary(filters: ValueRealizationFilters): Promise<ValueRealizationSummary> {
    const rows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      ${portfolioCte(filters.tenantId)}
      SELECT
        currency,
        COUNT(*)::int AS identified,
        COALESCE(SUM(estimated_monthly_savings), 0)::float8 AS estimated_monthly_savings,
        COALESCE(SUM(approved_monthly_savings), 0)::float8 AS approved_monthly_savings,
        COALESCE(SUM(reported_monthly_savings), 0)::float8 AS reported_monthly_savings,
        COALESCE(SUM(CASE WHEN measurement_status <> 'REJECTED' THEN observed_savings ELSE 0 END), 0)::float8 AS observed_savings,
        COALESCE(SUM(CASE WHEN measurement_status <> 'REJECTED' THEN projected_monthly_savings ELSE 0 END), 0)::float8 AS projected_monthly_savings,
        COALESCE(SUM(CASE WHEN measurement_status = 'VERIFIED' THEN projected_monthly_savings ELSE 0 END), 0)::float8 AS verified_monthly_savings,
        COALESCE(SUM(CASE WHEN measurement_status <> 'REJECTED' THEN cost_increase_monthly_amount ELSE 0 END), 0)::float8 AS cost_increase_monthly_amount
      FROM portfolio p
      ${filterWhere(filters)}
      GROUP BY currency
      ORDER BY currency ASC
    `);
    const countRows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      ${portfolioCte(filters.tenantId)}
      SELECT
        COUNT(*)::int AS identified,
        COUNT(*) FILTER (WHERE recommendation_status IN ('APPROVED', 'MANUAL_COMPLETED'))::int AS approved,
        COUNT(*) FILTER (WHERE manual_execution_status IN ('EXECUTED', 'PARTIAL'))::int AS executed,
        COUNT(*) FILTER (WHERE manual_execution_id IS NULL)::int AS without_measurement,
        COUNT(*) FILTER (WHERE measurement_status = 'WAITING_FOR_DATA')::int AS waiting_for_data,
        COUNT(*) FILTER (WHERE measurement_status = 'READY')::int AS ready_to_calculate,
        COUNT(*) FILTER (WHERE measurement_status = 'CALCULATED')::int AS calculated_pending_review,
        COUNT(*) FILTER (WHERE measurement_status = 'INSUFFICIENT_EVIDENCE')::int AS insufficient_evidence,
        COUNT(*) FILTER (WHERE measurement_status = 'VERIFIED')::int AS verified,
        COUNT(*) FILTER (WHERE measurement_status = 'REJECTED')::int AS rejected
      FROM portfolio p
      ${filterWhere(filters)}
    `);
    const count = countRows[0] ?? {};
    const projected = await this.projectSummaryRows(rows, filters.tenantId);
    return {
      generatedAt: new Date(),
      currencies: projected.currencies,
      ...(projected.conversionIssueCount === 0 ? {} : { conversionIssueCount: projected.conversionIssueCount }),
      counts: {
        identified: intValue(count['identified']),
        approved: intValue(count['approved']),
        executed: intValue(count['executed']),
        withoutMeasurement: intValue(count['without_measurement']),
        waitingForData: intValue(count['waiting_for_data']),
        readyToCalculate: intValue(count['ready_to_calculate']),
        calculatedPendingReview: intValue(count['calculated_pending_review']),
        insufficientEvidence: intValue(count['insufficient_evidence']),
        verified: intValue(count['verified']),
        rejected: intValue(count['rejected']),
      },
    };
  }

  public async listItems(filters: ValueRealizationFilters): Promise<ValueRealizationItemsPage> {
    const pageSize = Math.min(Math.max(filters.pageSize ?? defaultPageSize, 1), maxPageSize);
    const cursor = decodeCursor(filters.cursor);
    const rows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      ${portfolioCte(filters.tenantId)}
      SELECT * FROM portfolio p
      ${filterWhere(filters, cursor)}
      ORDER BY created_at DESC, recommendation_id DESC
      LIMIT ${pageSize + 1}
    `);
    const visibleRows = rows.slice(0, pageSize);
    const last = visibleRows.at(-1);
    return {
      items: await this.projectItems(visibleRows, filters.tenantId),
      hasMore: rows.length > pageSize,
      ...(rows.length > pageSize && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  public async listItemsForExport(filters: ValueRealizationFilters): Promise<readonly ReturnType<typeof toItem>[]> {
    const rows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      ${portfolioCte(filters.tenantId)}
      SELECT * FROM portfolio p
      ${filterWhere(filters)}
      ORDER BY created_at DESC, recommendation_id DESC
      LIMIT ${Math.min(Math.max(filters.pageSize ?? maxExportPageSize, 1), maxExportPageSize)}
    `);
    return this.projectItems(rows, filters.tenantId);
  }

  public async listTrend(filters: ValueRealizationFilters): Promise<readonly ValueRealizationTrendPoint[]> {
    const rows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      ${portfolioCte(filters.tenantId)}
      SELECT
        to_char(COALESCE(verified_at, observation_end, executed_at, created_at), 'YYYY-MM') AS period,
        currency,
        COALESCE(SUM(CASE WHEN measurement_status <> 'REJECTED' THEN observed_savings ELSE 0 END), 0)::float8 AS observed_savings,
        COALESCE(SUM(CASE WHEN measurement_status = 'VERIFIED' THEN projected_monthly_savings ELSE 0 END), 0)::float8 AS verified_monthly_savings,
        COALESCE(SUM(CASE WHEN measurement_status <> 'REJECTED' THEN cost_increase_monthly_amount ELSE 0 END), 0)::float8 AS cost_increase_monthly_amount,
        COUNT(*) FILTER (WHERE measurement_status = 'VERIFIED')::int AS verified_measurements
      FROM portfolio p
      ${filterWhere(filters)}
      GROUP BY 1, currency
      ORDER BY 1 ASC, currency ASC
    `);
    const target = await this.getReportingCurrency(filters.tenantId);
    return Promise.all(rows.map(async (row) => {
      const period = stringValue(row['period']) ?? '';
      const sourceCurrency = stringValue(row['currency']) ?? 'USD';
      const at = monthDate(period);
      const raw = [
        { amount: numberValue(row['observed_savings']), currency: sourceCurrency, at },
        { amount: numberValue(row['verified_monthly_savings']), currency: sourceCurrency, at },
        { amount: numberValue(row['cost_increase_monthly_amount']), currency: sourceCurrency, at },
      ];
      const projection = await this.projectAmounts(raw, target);
      const values = projection.hasIssue ? raw.map((item) => item.amount) : projection.values;
      return {
        period,
        currency: projection.hasIssue ? sourceCurrency : projection.currency,
        observedSavings: values[0]!,
        verifiedMonthlySavings: values[1]!,
        costIncreaseMonthlyAmount: values[2]!,
        verifiedMeasurements: intValue(row['verified_measurements']),
        ...(this.currencyConverter === undefined ? {} : { conversionStatus: projection.status }),
      };
    }));
  }

  private async projectSummaryRows(rows: readonly ValueRealizationRow[], tenantId: string): Promise<{ readonly currencies: readonly ValueRealizationSummary['currencies'][number][]; readonly conversionIssueCount: number }> {
    const target = await this.getReportingCurrency(tenantId);
    const summaries = new Map<string, ValueRealizationSummary['currencies'][number]>();
    let conversionIssueCount = 0;
    for (const row of rows) {
      const sourceCurrency = stringValue(row['currency']) ?? 'USD';
      const raw = [
        { amount: numberValue(row['estimated_monthly_savings']), currency: sourceCurrency, at: new Date() },
        { amount: numberValue(row['approved_monthly_savings']), currency: sourceCurrency, at: new Date() },
        { amount: numberValue(row['reported_monthly_savings']), currency: sourceCurrency, at: new Date() },
        { amount: numberValue(row['observed_savings']), currency: sourceCurrency, at: new Date() },
        { amount: numberValue(row['projected_monthly_savings']), currency: sourceCurrency, at: new Date() },
        { amount: numberValue(row['verified_monthly_savings']), currency: sourceCurrency, at: new Date() },
        { amount: numberValue(row['cost_increase_monthly_amount']), currency: sourceCurrency, at: new Date() },
      ];
      const projection = await this.projectAmounts(raw, target);
      if (projection.hasIssue) conversionIssueCount += 1;
      const values = projection.hasIssue ? raw.map((item) => item.amount) : projection.values;
      const currency = projection.hasIssue ? sourceCurrency : projection.currency;
      const estimated = values[0]!;
      const approved = values[1]!;
      const verified = values[5]!;
      const current = summaries.get(currency);
      summaries.set(currency, {
        currency,
        estimatedMonthlySavings: (current?.estimatedMonthlySavings ?? 0) + estimated,
        approvedMonthlySavings: (current?.approvedMonthlySavings ?? 0) + approved,
        reportedMonthlySavings: (current?.reportedMonthlySavings ?? 0) + values[2]!,
        observedSavings: (current?.observedSavings ?? 0) + values[3]!,
        projectedMonthlySavings: (current?.projectedMonthlySavings ?? 0) + values[4]!,
        verifiedMonthlySavings: (current?.verifiedMonthlySavings ?? 0) + verified,
        costIncreaseMonthlyAmount: (current?.costIncreaseMonthlyAmount ?? 0) + values[6]!,
        realizationRate: 0,
        varianceAgainstEstimate: 0,
        ...(this.currencyConverter === undefined ? {} : { conversionStatus: mergeStatus(current?.conversionStatus, projection.status) }),
      });
    }
    const currencies = [...summaries.values()].map((summary) => ({
      ...summary,
      realizationRate: summary.estimatedMonthlySavings > 0 ? summary.verifiedMonthlySavings / summary.estimatedMonthlySavings : 0,
      varianceAgainstEstimate: summary.verifiedMonthlySavings - summary.estimatedMonthlySavings,
    }));
    return { currencies, conversionIssueCount };
  }

  private async projectItems(rows: readonly ValueRealizationRow[], tenantId: string): Promise<readonly ValueRealizationItem[]> {
    const target = await this.getReportingCurrency(tenantId);
    return Promise.all(rows.map(async (row) => {
      const item = toItem(row);
      if (this.currencyConverter === undefined) return item;
      const at = dateValue(row['created_at']) ?? new Date();
      const sourceCurrency = stringValue(row['currency']) ?? item.currency;
      const reportedCurrency = stringValue(row['reported_currency']) ?? sourceCurrency;
      const measurementCurrency = stringValue(row['measurement_currency']) ?? sourceCurrency;
      const values: AmountValue[] = [
        { key: 'estimatedMonthlySavings', amount: item.estimatedMonthlySavings, currency: sourceCurrency, at },
        { key: 'reportedMonthlySavings', amount: item.reportedMonthlySavings, currency: reportedCurrency, at },
        { key: 'verifiedMonthlySavings', amount: item.verifiedMonthlySavings, currency: measurementCurrency, at },
        { key: 'costIncreaseMonthlyAmount', amount: item.costIncreaseMonthlyAmount, currency: measurementCurrency, at },
      ];
      if (item.observedSavings !== undefined) values.push({ key: 'observedSavings', amount: item.observedSavings, currency: measurementCurrency, at });
      if (item.projectedMonthlySavings !== undefined) values.push({ key: 'projectedMonthlySavings', amount: item.projectedMonthlySavings, currency: measurementCurrency, at });
      const projection = await this.projectAmounts(values, target);
      if (projection.hasIssue) return { ...item, conversionStatus: projection.status };
      const amounts = new Map(values.map((value, index) => [value.key, projection.values[index]!]));
      return {
        ...item,
        currency: projection.currency,
        estimatedMonthlySavings: amounts.get('estimatedMonthlySavings')!,
        reportedMonthlySavings: amounts.get('reportedMonthlySavings')!,
        ...(item.observedSavings === undefined ? {} : { observedSavings: amounts.get('observedSavings')! }),
        ...(item.projectedMonthlySavings === undefined ? {} : { projectedMonthlySavings: amounts.get('projectedMonthlySavings')! }),
        verifiedMonthlySavings: amounts.get('verifiedMonthlySavings')!,
        costIncreaseMonthlyAmount: amounts.get('costIncreaseMonthlyAmount')!,
        varianceAgainstEstimate: amounts.get('verifiedMonthlySavings')! - amounts.get('estimatedMonthlySavings')!,
        conversionStatus: projection.status,
      };
    }));
  }

  private async projectAmounts(values: readonly { readonly amount: number; readonly currency: string; readonly at: Date }[], target: string): Promise<ProjectedAmounts> {
    if (this.currencyConverter === undefined) {
      return { values: values.map((value) => value.amount), currency: values[0]?.currency ?? target, status: 'NOT_REQUIRED', hasIssue: false };
    }
    const projections = await this.currencyConverter.convertMany(values, target);
    const status = projections.reduce<CurrencyConversionStatus>((current, item) => mergeStatus(current, item.status), 'NOT_REQUIRED');
    return {
      values: projections.map((item, index) => item.amount ?? values[index]!.amount),
      currency: normalizeCurrencyCode(target),
      status,
      hasIssue: projections.some((item) => item.amount === null),
    };
  }

  private async getReportingCurrency(tenantId: string): Promise<string> {
    if (this.currencyConverter === undefined) return 'USD';
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { reportingCurrency: true } });
    return normalizeCurrencyCode(tenant?.reportingCurrency ?? 'USD');
  }
}

function mergeStatus(current: CurrencyConversionStatus | undefined, next: CurrencyConversionStatus): CurrencyConversionStatus {
  if (current === 'UNSUPPORTED_CURRENCY' || next === 'UNSUPPORTED_CURRENCY') return 'UNSUPPORTED_CURRENCY';
  if (current === 'MISSING_RATE' || next === 'MISSING_RATE') return 'MISSING_RATE';
  if (current === 'CONVERTED' || next === 'CONVERTED') return 'CONVERTED';
  return 'NOT_REQUIRED';
}

function dateValue(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

function monthDate(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (match === null) return new Date();
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

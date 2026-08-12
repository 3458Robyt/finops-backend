import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type {
  IValueRealizationRepository,
  ValueRealizationFilters,
  ValueRealizationSummary,
  ValueRealizationItemsPage,
  ValueRealizationTrendPoint,
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

export class PrismaValueRealizationPortfolioRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async getSummary(filters: ValueRealizationFilters): Promise<ValueRealizationSummary> {
    const rows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      ${portfolioCte(filters.tenantId)}
      SELECT
        currency,
        COUNT(*)::int AS identified,
        COALESCE(SUM(estimated_monthly_savings), 0)::float8 AS estimated_monthly_savings,
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
    return {
      generatedAt: new Date(),
      currencies: rows.map((row) => {
        const estimated = numberValue(row['estimated_monthly_savings']);
        const verified = numberValue(row['verified_monthly_savings']);
        return {
          currency: stringValue(row['currency']) ?? 'USD',
          estimatedMonthlySavings: estimated,
          reportedMonthlySavings: numberValue(row['reported_monthly_savings']),
          observedSavings: numberValue(row['observed_savings']),
          projectedMonthlySavings: numberValue(row['projected_monthly_savings']),
          verifiedMonthlySavings: verified,
          costIncreaseMonthlyAmount: numberValue(row['cost_increase_monthly_amount']),
          realizationRate: estimated > 0 ? verified / estimated : 0,
          varianceAgainstEstimate: verified - estimated,
        };
      }),
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
      items: visibleRows.map(toItem),
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
    return rows.map(toItem);
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
    return rows.map((row) => ({
      period: stringValue(row['period']) ?? '',
      currency: stringValue(row['currency']) ?? 'USD',
      observedSavings: numberValue(row['observed_savings']),
      verifiedMonthlySavings: numberValue(row['verified_monthly_savings']),
      costIncreaseMonthlyAmount: numberValue(row['cost_increase_monthly_amount']),
      verifiedMeasurements: intValue(row['verified_measurements']),
    }));
  }
}

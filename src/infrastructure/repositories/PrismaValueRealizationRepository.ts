import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type {
  IValueRealizationRepository,
  ValueRealizationCurrencySummary,
  ValueRealizationFilters,
  ValueRealizationItem,
  ValueRealizationItemsPage,
  ValueRealizationReconciliationCandidate,
  ValueRealizationSummary,
  ValueRealizationTrendPoint,
} from '../../domain/interfaces/IValueRealizationRepository.js';
import type { SavingsMeasurementStatus } from '../../domain/interfaces/IRecommendationRepository.js';

const defaultPageSize = 50;
const maxPageSize = 100;
const maxExportPageSize = 10_000;
const allowedStatuses = new Set<SavingsMeasurementStatus | 'NO_EXECUTION'>([
  'WAITING_FOR_DATA', 'READY', 'CALCULATED', 'INSUFFICIENT_EVIDENCE', 'VERIFIED', 'REJECTED', 'FAILED', 'NO_EXECUTION',
]);

type ValueRealizationRow = Record<string, unknown>;

export class PrismaValueRealizationRepository implements IValueRealizationRepository {
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
    const currencies: ValueRealizationCurrencySummary[] = rows.map((row) => {
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
    });

    return {
      generatedAt: new Date(),
      currencies,
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
      SELECT *
      FROM portfolio p
      ${filterWhere(filters, cursor)}
      ORDER BY created_at DESC, recommendation_id DESC
      LIMIT ${pageSize + 1}
    `);
    const hasMore = rows.length > pageSize;
    const visibleRows = rows.slice(0, pageSize);
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map(toItem),
      hasMore,
      ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  public async listItemsForExport(filters: ValueRealizationFilters): Promise<readonly ValueRealizationItem[]> {
    const rows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      ${portfolioCte(filters.tenantId)}
      SELECT *
      FROM portfolio p
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

  public async listReconciliationCandidates(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<readonly ValueRealizationReconciliationCandidate[]> {
    const limit = Math.min(Math.max(input.limit, 1), 250);
    const rows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      WITH latest_executions AS (
        SELECT
          me.id,
          me.tenant_id,
          me.recommendation_id,
          me.user_id,
          me.executed_at,
          ROW_NUMBER() OVER (PARTITION BY me.recommendation_id ORDER BY me.created_at DESC, me.id DESC) AS rn
        FROM recommendation_manual_executions me
        WHERE me.tenant_id = ${input.tenantId}
          AND me.status IN ('EXECUTED', 'PARTIAL')
          AND me.executed_at IS NOT NULL
      ), verified_executions AS (
        SELECT DISTINCT manual_execution_id
        FROM recommendation_savings_measurements
        WHERE tenant_id = ${input.tenantId} AND status = 'VERIFIED'
      )
      SELECT le.tenant_id, le.recommendation_id, le.id AS manual_execution_id,
             le.user_id AS requested_by_user_id, le.executed_at,
             latest_measurement.id AS latest_measurement_id
      FROM latest_executions le
      LEFT JOIN verified_executions ve ON ve.manual_execution_id = le.id
      LEFT JOIN LATERAL (
        SELECT m.id
        FROM recommendation_savings_measurements m
        WHERE m.tenant_id = le.tenant_id AND m.manual_execution_id = le.id
        ORDER BY CASE WHEN m.status = 'VERIFIED' THEN 0 WHEN m.status = 'REJECTED' THEN 2 ELSE 1 END,
                 m.created_at DESC, m.id DESC
        LIMIT 1
      ) latest_measurement ON TRUE
      WHERE le.rn = 1 AND ve.manual_execution_id IS NULL
      ORDER BY le.executed_at ASC, le.id ASC
      LIMIT ${limit}
    `);
    return rows.map((row) => {
      const latestMeasurementId = stringValue(row['latest_measurement_id']);
      return {
        tenantId: stringValue(row['tenant_id']) ?? input.tenantId,
        recommendationId: stringValue(row['recommendation_id']) ?? '',
        manualExecutionId: stringValue(row['manual_execution_id']) ?? '',
        requestedByUserId: stringValue(row['requested_by_user_id']) ?? '',
        executedAt: dateValue(row['executed_at']) ?? new Date(0),
        ...(latestMeasurementId !== undefined ? { latestMeasurementId } : {}),
      };
    });
  }
}

function portfolioCte(tenantId: string): Prisma.Sql {
  return Prisma.sql`
    WITH latest_executions AS (
      SELECT me.*,
             ROW_NUMBER() OVER (PARTITION BY me.recommendation_id ORDER BY me.created_at DESC, me.id DESC) AS execution_rn
      FROM recommendation_manual_executions me
      WHERE me.tenant_id = ${tenantId}
    ), latest_measurements AS (
      SELECT m.*,
             ROW_NUMBER() OVER (
               PARTITION BY m.manual_execution_id
               ORDER BY CASE WHEN m.status = 'VERIFIED' THEN 0 WHEN m.status = 'REJECTED' THEN 2 ELSE 1 END,
                        m.created_at DESC, m.id DESC
             ) AS measurement_rn
      FROM recommendation_savings_measurements m
      WHERE m.tenant_id = ${tenantId}
    )
    , portfolio AS (
      SELECT
        r.id AS recommendation_id,
        r.title,
        r.description,
        r.status::text AS recommendation_status,
        r.severity::text AS severity,
        r.type,
        r.cloud_account_id,
        ca.name AS cloud_account_name,
        ca.provider::text AS provider,
        COALESCE(lm.service_name, r.evidence ->> 'serviceName', r.evidence #>> '{resources,0,serviceName}') AS service_name,
        COALESCE(lm.resource_id, r.evidence ->> 'externalResourceId', r.evidence #>> '{resources,0,externalResourceId}') AS resource_id,
        r.currency,
        COALESCE(r.estimated_monthly_savings, 0)::float8 AS estimated_monthly_savings,
        COALESCE(le.observed_monthly_savings, 0)::float8 AS reported_monthly_savings,
        le.id AS manual_execution_id,
        le.status::text AS manual_execution_status,
        le.executed_at,
        lm.id AS measurement_id,
        lm.status::text AS measurement_status,
        lm.observed_savings::float8 AS observed_savings,
        lm.projected_monthly_savings::float8 AS projected_monthly_savings,
        CASE WHEN lm.status = 'VERIFIED' THEN COALESCE(lm.projected_monthly_savings, 0)::float8 ELSE 0 END AS verified_monthly_savings,
        COALESCE(lm.cost_increase_monthly_amount, 0)::float8 AS cost_increase_monthly_amount,
        lm.coverage_ratio::float8 AS coverage_ratio,
        lm.confidence_level,
        lm.billing_source::text AS billing_source,
        lm.cost_basis,
        lm.observation_end,
        lm.verified_at,
        r.created_at,
        r.updated_at,
        CASE
          WHEN le.id IS NULL THEN 'EXECUTE'
          WHEN lm.id IS NULL THEN 'MEASURE'
          WHEN lm.status = 'WAITING_FOR_DATA' THEN 'WAIT_FOR_DATA'
          WHEN lm.status IN ('READY', 'CALCULATED') THEN 'REVIEW'
          WHEN lm.status = 'INSUFFICIENT_EVIDENCE' THEN 'REVIEW_EVIDENCE'
          WHEN lm.status = 'REJECTED' THEN 'RECALCULATE'
          ELSE 'NONE'
        END AS next_action
      FROM recommendations r
      INNER JOIN cloud_accounts ca ON ca.id = r.cloud_account_id AND ca.tenant_id = r.tenant_id
      LEFT JOIN latest_executions le ON le.recommendation_id = r.id AND le.execution_rn = 1
      LEFT JOIN latest_measurements lm ON lm.manual_execution_id = le.id AND lm.measurement_rn = 1
      WHERE r.tenant_id = ${tenantId}
    )
  `;
}

function filterWhere(filters: ValueRealizationFilters, cursor?: { readonly createdAt: Date; readonly id: string }): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filters.status !== undefined) {
    if (!allowedStatuses.has(filters.status)) throw new Error('Estado de medición no válido');
    conditions.push(filters.status === 'NO_EXECUTION'
      ? Prisma.sql`p.measurement_status IS NULL`
      : Prisma.sql`p.measurement_status = ${filters.status}`);
  }
  if (filters.currency !== undefined) conditions.push(Prisma.sql`p.currency = ${filters.currency}`);
  if (filters.provider !== undefined) conditions.push(Prisma.sql`p.provider = ${filters.provider}`);
  if (filters.cloudAccountId !== undefined) conditions.push(Prisma.sql`p.cloud_account_id = ${filters.cloudAccountId}`);
  if (filters.serviceName !== undefined) conditions.push(Prisma.sql`p.service_name = ${filters.serviceName}`);
  if (filters.resourceId !== undefined) conditions.push(Prisma.sql`p.resource_id = ${filters.resourceId}`);
  if (filters.severity !== undefined) conditions.push(Prisma.sql`p.severity = ${filters.severity}`);
  if (filters.executedFrom !== undefined) conditions.push(Prisma.sql`p.executed_at >= ${filters.executedFrom}`);
  if (filters.executedTo !== undefined) conditions.push(Prisma.sql`p.executed_at < ${filters.executedTo}`);
  if (filters.verifiedFrom !== undefined) conditions.push(Prisma.sql`p.verified_at >= ${filters.verifiedFrom}`);
  if (filters.verifiedTo !== undefined) conditions.push(Prisma.sql`p.verified_at < ${filters.verifiedTo}`);
  if (filters.search !== undefined && filters.search.trim() !== '') {
    const search = `%${filters.search.trim()}%`;
    conditions.push(Prisma.sql`(p.title ILIKE ${search} OR p.description ILIKE ${search} OR COALESCE(p.service_name, '') ILIKE ${search} OR COALESCE(p.resource_id, '') ILIKE ${search})`);
  }
  if (filters.onlyIncreases === true) conditions.push(Prisma.sql`p.cost_increase_monthly_amount > 0`);
  if (filters.onlyPending === true) conditions.push(Prisma.sql`(p.measurement_status IS NULL OR p.measurement_status IN ('WAITING_FOR_DATA', 'READY', 'CALCULATED', 'INSUFFICIENT_EVIDENCE', 'REJECTED'))`);
  if (cursor !== undefined) {
    conditions.push(Prisma.sql`(p.created_at, p.recommendation_id) < (${cursor.createdAt}, ${cursor.id})`);
  }
  return conditions.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
}

function toItem(row: ValueRealizationRow): ValueRealizationItem {
  const estimated = numberValue(row['estimated_monthly_savings']);
  const verified = numberValue(row['verified_monthly_savings']);
  const manualExecutionId = stringValue(row['manual_execution_id']);
  const measurementId = stringValue(row['measurement_id']);
  const serviceName = stringValue(row['service_name']);
  const resourceId = stringValue(row['resource_id']);
  const confidenceLevel = stringValue(row['confidence_level']);
  const billingSource = stringValue(row['billing_source']);
  const costBasis = stringValue(row['cost_basis']);
  const executedAt = dateValue(row['executed_at']);
  const observationEnd = dateValue(row['observation_end']);
  const verifiedAt = dateValue(row['verified_at']);
  const measurementStatus = stringValue(row['measurement_status']) as ValueRealizationItem['measurementStatus'] | undefined;
  return {
    recommendationId: stringValue(row['recommendation_id']) ?? '',
    ...(manualExecutionId !== undefined ? { manualExecutionId } : {}),
    ...(measurementId !== undefined ? { measurementId } : {}),
    title: stringValue(row['title']) ?? '',
    description: stringValue(row['description']) ?? '',
    recommendationStatus: stringValue(row['recommendation_status']) ?? 'PENDING',
    severity: stringValue(row['severity']) ?? 'MEDIUM',
    type: stringValue(row['type']) ?? '',
    cloudAccountId: stringValue(row['cloud_account_id']) ?? '',
    cloudAccountName: stringValue(row['cloud_account_name']) ?? '',
    provider: stringValue(row['provider']) ?? '',
    ...(serviceName !== undefined ? { serviceName } : {}),
    ...(resourceId !== undefined ? { resourceId } : {}),
    currency: stringValue(row['currency']) ?? 'USD',
    estimatedMonthlySavings: estimated,
    reportedMonthlySavings: numberValue(row['reported_monthly_savings']),
    ...(row['observed_savings'] !== null && row['observed_savings'] !== undefined ? { observedSavings: numberValue(row['observed_savings']) } : {}),
    ...(row['projected_monthly_savings'] !== null && row['projected_monthly_savings'] !== undefined ? { projectedMonthlySavings: numberValue(row['projected_monthly_savings']) } : {}),
    verifiedMonthlySavings: verified,
    costIncreaseMonthlyAmount: numberValue(row['cost_increase_monthly_amount']),
    varianceAgainstEstimate: verified - estimated,
    ...(row['coverage_ratio'] !== null && row['coverage_ratio'] !== undefined ? { coverageRatio: numberValue(row['coverage_ratio']) } : {}),
    ...(confidenceLevel !== undefined ? { confidenceLevel } : {}),
    ...(billingSource !== undefined ? { billingSource } : {}),
    ...(costBasis !== undefined ? { costBasis } : {}),
    ...(measurementStatus !== undefined ? { measurementStatus } : { measurementStatus: 'NO_EXECUTION' }),
    ...(executedAt !== undefined ? { executedAt } : {}),
    ...(observationEnd !== undefined ? { observationEnd } : {}),
    ...(verifiedAt !== undefined ? { verifiedAt } : {}),
    nextAction: (stringValue(row['next_action']) ?? 'NONE') as ValueRealizationItem['nextAction'],
    createdAt: dateValue(row['created_at']) ?? new Date(0),
    updatedAt: dateValue(row['updated_at']) ?? new Date(0),
  };
}

function encodeCursor(row: ValueRealizationRow): string {
  const value = JSON.stringify({
    createdAt: (dateValue(row['created_at']) ?? new Date(0)).toISOString(),
    id: stringValue(row['recommendation_id']) ?? '',
  });
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): { readonly createdAt: Date; readonly id: string } | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    const createdAt = dateValue(parsed.createdAt);
    if (createdAt === undefined || typeof parsed.id !== 'string' || parsed.id === '') throw new Error('invalid cursor');
    return { createdAt, id: parsed.id };
  } catch {
    throw new Error('El cursor de valor realizado no es válido');
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function intValue(value: unknown): number {
  return Math.trunc(numberValue(value));
}

function dateValue(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

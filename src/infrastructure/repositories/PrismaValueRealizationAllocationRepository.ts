import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type {
  ValueRealizationDestinationSummary,
  ValueRealizationReconciliationCandidate,
} from '../../domain/interfaces/IValueRealizationRepository.js';
import {
  dateValue,
  intValue,
  monthStart,
  numberValue,
  stringValue,
  type ValueRealizationRow,
} from './valueRealizationRepositorySupport.js';
import { CurrencyConverter, normalizeCurrencyCode, type CurrencyConversionStatus } from '../finance/CurrencyConverter.js';

export class PrismaValueRealizationAllocationRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly currencyConverter?: CurrencyConverter,
  ) {}

  public async listDestinationSummary(input: { readonly tenantId: string; readonly period: Date; readonly currency?: string }): Promise<readonly ValueRealizationDestinationSummary[]> {
    const period = monthStart(input.period);
    const rows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      WITH closed_periods AS (
        SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.tenant_id, c.period_start, c.currency ORDER BY c.version DESC) AS closure_rn
        FROM cost_allocation_closures c
        WHERE c.tenant_id = ${input.tenantId} AND c.status = 'CLOSED' AND c.period_start = ${period}
      ), latest_executions AS (
        SELECT me.*, ROW_NUMBER() OVER (PARTITION BY me.recommendation_id ORDER BY me.created_at DESC, me.id DESC) AS execution_rn
        FROM recommendation_manual_executions me WHERE me.tenant_id = ${input.tenantId}
      ), latest_measurements AS (
        SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.manual_execution_id ORDER BY CASE WHEN m.status = 'VERIFIED' THEN 0 WHEN m.status = 'REJECTED' THEN 2 ELSE 1 END, m.created_at DESC, m.id DESC) AS measurement_rn
        FROM recommendation_savings_measurements m WHERE m.tenant_id = ${input.tenantId}
      ), source_evidence AS (
        SELECT e.tenant_id, e.recommendation_id, e.charge_period_start, e.metric_identity_hash,
               e.billing_currency AS source_currency, e.billed_cost AS source_amount,
               e.cloud_account_id, e.provider::text AS provider, e.cloud_resource_id
        FROM recommendation_cost_evidence e
        WHERE e.tenant_id = ${input.tenantId}
        UNION ALL
        SELECT r.tenant_id, r.id, r.source_charge_period_start, r.source_metric_identity_hash,
               NULL::varchar(3), NULL::numeric, NULL::text, NULL::text, r.cloud_resource_id
        FROM recommendations r
        WHERE r.tenant_id = ${input.tenantId}
          AND r.source_charge_period_start IS NOT NULL
          AND r.source_metric_identity_hash IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM recommendation_cost_evidence e
            WHERE e.tenant_id = r.tenant_id AND e.recommendation_id = r.id
          )
      ), expected_evidence AS (
        SELECT r.id AS recommendation_id, c.id AS closure_id, COUNT(*)::int AS expected_count
        FROM recommendations r
        INNER JOIN source_evidence e ON e.tenant_id = r.tenant_id AND e.recommendation_id = r.id
        INNER JOIN closed_periods c ON c.tenant_id = r.tenant_id AND c.closure_rn = 1
          AND c.currency = r.currency
          AND e.charge_period_start >= c.period_start
          AND e.charge_period_start < c.period_start + INTERVAL '1 month'
        WHERE r.tenant_id = ${input.tenantId}
          AND r.status <> 'REJECTED'
          AND COALESCE(r.estimated_monthly_savings, 0) > 0
          AND COALESCE(r.evidence ->> 'reviewScope', '') <> 'FINANCIAL'
          AND COALESCE(r.evidence ->> 'financialReviewOnly', '') <> 'true'
          AND (e.source_amount IS NULL OR e.source_amount > 0)
          ${input.currency === undefined ? Prisma.empty : Prisma.sql`AND r.currency = ${input.currency}`}
        GROUP BY r.id, c.id
      ), matched_evidence AS (
        SELECT r.id AS recommendation_id, r.tenant_id, r.currency, r.status, r.created_at,
               r.estimated_monthly_savings, c.id AS closure_id,
               e.cloud_account_id, e.provider, e.cloud_resource_id,
               e.charge_period_start, e.metric_identity_hash,
               MIN(l.source_amount) AS source_amount
        FROM recommendations r
        INNER JOIN source_evidence e ON e.tenant_id = r.tenant_id AND e.recommendation_id = r.id
        INNER JOIN closed_periods c ON c.tenant_id = r.tenant_id AND c.closure_rn = 1
          AND c.currency = r.currency
          AND e.charge_period_start >= c.period_start
          AND e.charge_period_start < c.period_start + INTERVAL '1 month'
          AND (e.source_currency IS NULL OR e.source_currency = c.currency)
        INNER JOIN cost_allocation_closure_lines l ON l.tenant_id = r.tenant_id AND l.closure_id = c.id
          AND l.charge_period_start = e.charge_period_start
          AND l.metric_identity_hash = e.metric_identity_hash
          AND l.currency = c.currency
          AND l.cloud_resource_id IS NOT DISTINCT FROM e.cloud_resource_id
          AND (e.cloud_account_id IS NULL OR l.cloud_account_id = e.cloud_account_id)
          AND (e.provider IS NULL OR l.provider::text = e.provider)
          AND (e.source_amount IS NULL OR l.source_amount = e.source_amount)
          AND l.source_amount > 0
        WHERE r.tenant_id = ${input.tenantId}
          AND r.status <> 'REJECTED'
          AND COALESCE(r.estimated_monthly_savings, 0) > 0
          AND COALESCE(r.evidence ->> 'reviewScope', '') <> 'FINANCIAL'
          AND COALESCE(r.evidence ->> 'financialReviewOnly', '') <> 'true'
          ${input.currency === undefined ? Prisma.empty : Prisma.sql`AND r.currency = ${input.currency}`}
        GROUP BY r.id, r.tenant_id, r.currency, r.status, r.created_at,
                 r.estimated_monthly_savings, c.id, e.cloud_account_id, e.provider,
                 e.cloud_resource_id, e.charge_period_start, e.metric_identity_hash
        HAVING MIN(l.source_amount) = MAX(l.source_amount)
      ), ranked_evidence AS (
        SELECT e.*,
               ROW_NUMBER() OVER (
                 PARTITION BY e.closure_id, e.charge_period_start, e.metric_identity_hash
                 ORDER BY CASE WHEN e.status IN ('APPROVED', 'MANUAL_COMPLETED') THEN 0 ELSE 1 END,
                          e.estimated_monthly_savings DESC, e.created_at ASC, e.recommendation_id ASC
               ) AS claim_rank
        FROM matched_evidence e
      ), ownership AS (
        SELECT expected.recommendation_id, expected.closure_id, expected.expected_count,
               COUNT(ranked.metric_identity_hash)::int AS matched_count,
               COUNT(*) FILTER (WHERE ranked.claim_rank = 1)::int AS owned_count
        FROM expected_evidence expected
        LEFT JOIN ranked_evidence ranked
          ON ranked.recommendation_id = expected.recommendation_id
         AND ranked.closure_id = expected.closure_id
        GROUP BY expected.recommendation_id, expected.closure_id, expected.expected_count
      ), eligible_recommendations AS (
        SELECT recommendation_id, closure_id
        FROM ownership
        WHERE expected_count > 0 AND matched_count = expected_count AND owned_count = expected_count
      ), evidence_totals AS (
        SELECT eligible.recommendation_id, eligible.closure_id,
               SUM(evidence.source_amount) AS source_total
        FROM eligible_recommendations eligible
        INNER JOIN ranked_evidence evidence ON evidence.recommendation_id = eligible.recommendation_id
          AND evidence.closure_id = eligible.closure_id AND evidence.claim_rank = 1
        GROUP BY eligible.recommendation_id, eligible.closure_id
      ), allocation_totals AS (
        SELECT eligible.recommendation_id, eligible.closure_id, line.allocation_key, closure.currency,
               SUM(line.allocation_amount) AS allocation_amount
        FROM eligible_recommendations eligible
        INNER JOIN ranked_evidence evidence ON evidence.recommendation_id = eligible.recommendation_id
          AND evidence.closure_id = eligible.closure_id AND evidence.claim_rank = 1
        INNER JOIN cost_allocation_closure_lines line ON line.tenant_id = evidence.tenant_id
          AND line.closure_id = evidence.closure_id
          AND line.charge_period_start = evidence.charge_period_start
          AND line.metric_identity_hash = evidence.metric_identity_hash
          AND line.source_amount = evidence.source_amount
          AND line.cloud_resource_id IS NOT DISTINCT FROM evidence.cloud_resource_id
          AND (evidence.cloud_account_id IS NULL OR line.cloud_account_id = evidence.cloud_account_id)
          AND (evidence.provider IS NULL OR line.provider::text = evidence.provider)
          AND line.currency = evidence.currency
        INNER JOIN closed_periods closure ON closure.id = eligible.closure_id AND closure.closure_rn = 1
        GROUP BY eligible.recommendation_id, eligible.closure_id, line.allocation_key, closure.currency
      ), attributed AS (
        SELECT r.id AS recommendation_id, r.currency, allocations.allocation_key,
               COALESCE(r.estimated_monthly_savings, 0) * allocations.allocation_amount / NULLIF(totals.source_total, 0) AS potential_savings,
               CASE WHEN r.status IN ('APPROVED', 'MANUAL_COMPLETED')
                    THEN COALESCE(r.estimated_monthly_savings, 0) * allocations.allocation_amount / NULLIF(totals.source_total, 0)
                    ELSE 0 END AS approved_savings,
               CASE WHEN lm.status = 'VERIFIED' THEN COALESCE(lm.projected_monthly_savings, 0) * allocations.allocation_amount / NULLIF(totals.source_total, 0) ELSE 0 END AS verified_savings,
               CASE WHEN lm.status <> 'REJECTED' THEN COALESCE(lm.observed_savings, 0) * allocations.allocation_amount / NULLIF(totals.source_total, 0) ELSE 0 END AS observed_savings
        FROM allocation_totals allocations
        INNER JOIN evidence_totals totals ON totals.recommendation_id = allocations.recommendation_id AND totals.closure_id = allocations.closure_id
        INNER JOIN recommendations r ON r.id = allocations.recommendation_id AND r.tenant_id = ${input.tenantId}
        LEFT JOIN latest_executions le ON le.recommendation_id = r.id AND le.execution_rn = 1
        LEFT JOIN latest_measurements lm ON lm.manual_execution_id = le.id AND lm.measurement_rn = 1
      )
      SELECT ${period.toISOString().slice(0, 7)} AS period, allocation_key, currency,
             COALESCE(SUM(potential_savings), 0)::float8 AS potential_savings,
             COALESCE(SUM(approved_savings), 0)::float8 AS approved_savings,
             COALESCE(SUM(verified_savings), 0)::float8 AS verified_savings,
             COALESCE(SUM(observed_savings), 0)::float8 AS observed_savings,
             COUNT(DISTINCT recommendation_id)::int AS attributed_recommendations
      FROM attributed GROUP BY allocation_key, currency ORDER BY currency ASC, allocation_key ASC
    `);
    const target = await this.getReportingCurrency(input.tenantId);
    return Promise.all(rows.map(async (row) => {
      const sourceCurrency = stringValue(row['currency']) ?? 'USD';
      const raw = [
        { amount: numberValue(row['potential_savings']), currency: sourceCurrency, at: period },
        { amount: numberValue(row['approved_savings']), currency: sourceCurrency, at: period },
        { amount: numberValue(row['verified_savings']), currency: sourceCurrency, at: period },
        { amount: numberValue(row['observed_savings']), currency: sourceCurrency, at: period },
      ];
      const projections = this.currencyConverter === undefined
        ? raw.map((item) => ({ amount: item.amount, status: 'NOT_REQUIRED' as const }))
        : await this.currencyConverter.convertMany(raw, target);
      const status = projections.reduce<CurrencyConversionStatus>((current, item) => mergeStatus(current, item.status), 'NOT_REQUIRED');
      const hasIssue = projections.some((item) => item.amount === null);
      const values = hasIssue ? raw.map((item) => item.amount) : projections.map((item) => item.amount ?? 0);
      return {
        period: stringValue(row['period']) ?? period.toISOString().slice(0, 7),
        allocationKey: stringValue(row['allocation_key']) ?? 'UNALLOCATED',
        currency: hasIssue ? sourceCurrency : target,
        potentialSavings: values[0]!,
        approvedSavings: values[1]!,
        verifiedSavings: values[2]!,
        observedSavings: values[3]!,
        attributedRecommendations: intValue(row['attributed_recommendations']),
        ...(this.currencyConverter === undefined ? {} : { conversionStatus: status }),
      };
    }));
  }

  private async getReportingCurrency(tenantId: string): Promise<string> {
    if (this.currencyConverter === undefined) return 'USD';
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { reportingCurrency: true } });
    return normalizeCurrencyCode(tenant?.reportingCurrency ?? 'USD');
  }

  public async listReconciliationCandidates(input: { readonly tenantId: string; readonly limit: number }): Promise<readonly ValueRealizationReconciliationCandidate[]> {
    const limit = Math.min(Math.max(input.limit, 1), 250);
    const rows = await this.prisma.$queryRaw<Array<ValueRealizationRow>>(Prisma.sql`
      WITH eligible_executions AS (
        SELECT me.id, me.tenant_id, me.recommendation_id, me.user_id, me.executed_at
        FROM recommendation_manual_executions me
        WHERE me.tenant_id = ${input.tenantId} AND me.status IN ('EXECUTED', 'PARTIAL') AND me.executed_at IS NOT NULL
      ), verified_executions AS (
        SELECT DISTINCT manual_execution_id FROM recommendation_savings_measurements
        WHERE tenant_id = ${input.tenantId} AND status = 'VERIFIED'
      )
      SELECT le.tenant_id, le.recommendation_id, le.id AS manual_execution_id, le.user_id AS requested_by_user_id, le.executed_at, latest_measurement.id AS latest_measurement_id
      FROM eligible_executions le
      LEFT JOIN verified_executions ve ON ve.manual_execution_id = le.id
      LEFT JOIN LATERAL (
        SELECT m.id FROM recommendation_savings_measurements m
        WHERE m.tenant_id = le.tenant_id AND m.manual_execution_id = le.id
        ORDER BY CASE WHEN m.status = 'VERIFIED' THEN 0 WHEN m.status = 'REJECTED' THEN 2 ELSE 1 END, m.created_at DESC, m.id DESC
        LIMIT 1
      ) latest_measurement ON TRUE
      WHERE ve.manual_execution_id IS NULL
      ORDER BY (le.executed_at + INTERVAL '30 days' <= CURRENT_TIMESTAMP) DESC, le.executed_at ASC, le.id ASC
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

function mergeStatus(current: CurrencyConversionStatus, next: CurrencyConversionStatus): CurrencyConversionStatus {
  if (current === 'UNSUPPORTED_CURRENCY' || next === 'UNSUPPORTED_CURRENCY') return 'UNSUPPORTED_CURRENCY';
  if (current === 'MISSING_RATE' || next === 'MISSING_RATE') return 'MISSING_RATE';
  if (current === 'CONVERTED' || next === 'CONVERTED') return 'CONVERTED';
  return 'NOT_REQUIRED';
}

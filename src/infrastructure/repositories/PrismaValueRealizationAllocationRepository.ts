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

export class PrismaValueRealizationAllocationRepository {
  constructor(private readonly prisma: PrismaClient) {}

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
      ), attributed AS (
        SELECT r.id AS recommendation_id, r.currency, l.allocation_key,
               CASE WHEN r.status <> 'REJECTED' THEN COALESCE(r.estimated_monthly_savings, 0) * l.allocation_amount / NULLIF(l.source_amount, 0) ELSE 0 END AS potential_savings,
               CASE WHEN r.status IN ('APPROVED', 'MANUAL_COMPLETED') THEN COALESCE(r.estimated_monthly_savings, 0) * l.allocation_amount / NULLIF(l.source_amount, 0) ELSE 0 END AS approved_savings,
               CASE WHEN lm.status = 'VERIFIED' THEN COALESCE(lm.projected_monthly_savings, 0) * l.allocation_amount / NULLIF(l.source_amount, 0) ELSE 0 END AS verified_savings,
               CASE WHEN lm.status <> 'REJECTED' THEN COALESCE(lm.observed_savings, 0) * l.allocation_amount / NULLIF(l.source_amount, 0) ELSE 0 END AS observed_savings
        FROM recommendations r
        INNER JOIN cost_allocation_closure_lines l ON l.tenant_id = r.tenant_id AND l.currency = r.currency AND l.cloud_resource_id = r.cloud_resource_id AND l.metric_identity_hash = r.source_metric_identity_hash AND l.charge_period_start = r.source_charge_period_start AND l.source_amount > 0
        INNER JOIN closed_periods c ON c.id = l.closure_id AND c.closure_rn = 1 AND r.source_charge_period_start >= c.period_start AND r.source_charge_period_start < c.period_start + INTERVAL '1 month'
        LEFT JOIN latest_executions le ON le.recommendation_id = r.id AND le.execution_rn = 1
        LEFT JOIN latest_measurements lm ON lm.manual_execution_id = le.id AND lm.measurement_rn = 1
        WHERE r.tenant_id = ${input.tenantId} AND r.source_charge_period_start IS NOT NULL AND r.source_metric_identity_hash IS NOT NULL
          ${input.currency === undefined ? Prisma.empty : Prisma.sql`AND r.currency = ${input.currency}`}
      )
      SELECT ${period.toISOString().slice(0, 7)} AS period, allocation_key, currency,
             COALESCE(SUM(potential_savings), 0)::float8 AS potential_savings,
             COALESCE(SUM(approved_savings), 0)::float8 AS approved_savings,
             COALESCE(SUM(verified_savings), 0)::float8 AS verified_savings,
             COALESCE(SUM(observed_savings), 0)::float8 AS observed_savings,
             COUNT(DISTINCT recommendation_id)::int AS attributed_recommendations
      FROM attributed GROUP BY allocation_key, currency ORDER BY currency ASC, allocation_key ASC
    `);
    return rows.map((row) => ({
      period: stringValue(row['period']) ?? period.toISOString().slice(0, 7),
      allocationKey: stringValue(row['allocation_key']) ?? 'UNALLOCATED',
      currency: stringValue(row['currency']) ?? 'USD',
      potentialSavings: numberValue(row['potential_savings']),
      approvedSavings: numberValue(row['approved_savings']),
      verifiedSavings: numberValue(row['verified_savings']),
      observedSavings: numberValue(row['observed_savings']),
      attributedRecommendations: intValue(row['attributed_recommendations']),
    }));
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

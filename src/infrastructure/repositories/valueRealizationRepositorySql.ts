import { Prisma } from '../../generated/prisma/client.js';
import type { SavingsMeasurementStatus } from '../../domain/interfaces/IRecommendationRepository.js';
import type { ValueRealizationFilters } from '../../domain/interfaces/IValueRealizationRepository.js';
import type { ValueRealizationCursor } from './valueRealizationRepositorySupport.js';

const allowedStatuses = new Set<SavingsMeasurementStatus | 'NO_EXECUTION'>([
  'WAITING_FOR_DATA', 'READY', 'CALCULATED', 'INSUFFICIENT_EVIDENCE', 'VERIFIED', 'REJECTED', 'FAILED', 'NO_EXECUTION',
]);

export function portfolioCte(tenantId: string): Prisma.Sql {
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

export function filterWhere(filters: ValueRealizationFilters, cursor?: ValueRealizationCursor): Prisma.Sql {
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
  if (cursor !== undefined) conditions.push(Prisma.sql`(p.created_at, p.recommendation_id) < (${cursor.createdAt}, ${cursor.id})`);
  return conditions.length === 0 ? Prisma.empty : Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
}

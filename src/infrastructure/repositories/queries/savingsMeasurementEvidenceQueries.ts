import type {
  SavingsMeasurementReadiness,
  SavingsMeasurementScope,
} from '../../../domain/interfaces/IRecommendationRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { Prisma } from '../../../generated/prisma/client.js';
import type { SavingsCostAggregate } from '../../../application/services/savings/DeterministicSavingsCalculator.js';

export type CloudProviderValue = 'AWS' | 'OCI' | 'AZURE' | 'GCP' | 'CUSTOM';

export interface MeasurementContext {
  readonly tenantId: string;
  readonly recommendationId: string;
  readonly manualExecution: {
    readonly id: string;
    readonly status: string;
    readonly executedAt: Date | null;
    readonly executionPlanId: string | null;
  };
  readonly provider: CloudProviderValue;
  readonly cloudAccountId: string;
  readonly currency: string;
  readonly scope: SavingsMeasurementScope;
  readonly resourceId?: string;
  readonly serviceName?: string;
  readonly technicalEvidenceRequired: boolean;
  readonly windowDays: number;
  readonly baselineStart: Date;
  readonly baselineEnd: Date;
  readonly observationStart: Date;
  readonly observationEnd: Date;
}

export interface AggregateResult {
  readonly baseline: SavingsCostAggregate;
  readonly observation: SavingsCostAggregate;
  readonly billingSource: 'FOCUS' | 'PROVIDER_API' | 'LEGACY' | 'UNKNOWN';
  readonly costBasis?: 'EFFECTIVE' | 'BILLED';
  readonly billingSources: readonly string[];
  readonly currencies: readonly string[];
  readonly cloudConnectionIds: readonly string[];
  readonly technicalSampleCount: number;
  readonly technicalEvidenceAvailable: boolean;
  readonly technicalCriticalSignal: boolean;
  readonly unit?: string;
}

export async function readSavingsAggregate(
  prisma: PrismaClient,
  context: MeasurementContext,
): Promise<AggregateResult & {
  readonly status: SavingsMeasurementReadiness['status'];
  readonly reasons: readonly string[];
  readonly availableThrough?: Date;
}> {
  const scopeClause = context.scope === 'RESOURCE'
    ? Prisma.sql`AND resource_id = ${context.resourceId}`
    : context.scope === 'SERVICE'
      ? Prisma.sql`AND service_name = ${context.serviceName}`
      : context.scope === 'ACCOUNT' ? Prisma.empty : Prisma.sql`AND FALSE`;
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      COALESCE(SUM(CASE WHEN charge_period_start >= ${context.baselineStart} AND charge_period_start < ${context.baselineEnd} THEN billed_cost ELSE 0 END), 0)::float8 AS baseline_billed,
      COALESCE(SUM(CASE WHEN charge_period_start >= ${context.observationStart} AND charge_period_start < ${context.observationEnd} THEN billed_cost ELSE 0 END), 0)::float8 AS observation_billed,
      COALESCE(SUM(CASE WHEN charge_period_start >= ${context.baselineStart} AND charge_period_start < ${context.baselineEnd} THEN effective_cost ELSE 0 END), 0)::float8 AS baseline_effective,
      COALESCE(SUM(CASE WHEN charge_period_start >= ${context.observationStart} AND charge_period_start < ${context.observationEnd} THEN effective_cost ELSE 0 END), 0)::float8 AS observation_effective,
      count(*) FILTER (WHERE charge_period_start >= ${context.baselineStart} AND charge_period_start < ${context.baselineEnd})::int AS baseline_count,
      count(*) FILTER (WHERE charge_period_start >= ${context.observationStart} AND charge_period_start < ${context.observationEnd})::int AS observation_count,
      count(DISTINCT (charge_period_start AT TIME ZONE 'UTC')::date) FILTER (WHERE charge_period_start >= ${context.baselineStart} AND charge_period_start < ${context.baselineEnd})::int AS baseline_days,
      count(DISTINCT (charge_period_start AT TIME ZONE 'UTC')::date) FILTER (WHERE charge_period_start >= ${context.observationStart} AND charge_period_start < ${context.observationEnd})::int AS observation_days,
      COALESCE(SUM(consumed_quantity) FILTER (WHERE charge_period_start >= ${context.baselineStart} AND charge_period_start < ${context.baselineEnd}), 0)::float8 AS baseline_quantity,
      COALESCE(SUM(consumed_quantity) FILTER (WHERE charge_period_start >= ${context.observationStart} AND charge_period_start < ${context.observationEnd}), 0)::float8 AS observation_quantity,
      count(*) FILTER (WHERE effective_cost IS NULL AND charge_period_start >= ${context.baselineStart} AND charge_period_start < ${context.observationEnd})::int AS effective_null_count,
      array_remove(array_agg(DISTINCT billing_source::text), NULL) AS billing_sources,
      array_remove(array_agg(DISTINCT billing_currency), NULL) AS currencies,
      array_remove(array_agg(DISTINCT COALESCE(cloud_connection_id, '')), NULL) AS cloud_connection_ids,
      array_remove(array_agg(DISTINCT consumed_unit), NULL) AS units,
      max(charge_period_start) AS available_through
    FROM cost_metrics
    WHERE tenant_id = ${context.tenantId}
      AND cloud_account_id = ${context.cloudAccountId}
      AND provider::text = ${context.provider}
      AND charge_category = 'Usage'
      AND charge_period_start >= ${context.baselineStart}
      AND charge_period_start < ${context.observationEnd}
      ${scopeClause}
  `);
  const row = rows[0] ?? {};
  const sources = readStringArray(row['billing_sources']);
  const currencies = readStringArray(row['currencies']);
  const connections = readStringArray(row['cloud_connection_ids']);
  const units = readStringArray(row['units']);
  const effectiveUsable = Number(row['effective_null_count'] ?? 0) === 0
    && Number(row['baseline_count'] ?? 0) + Number(row['observation_count'] ?? 0) > 0;
  const costBasis = effectiveUsable ? 'EFFECTIVE' : 'BILLED';
  const billingSource = sources.length === 1 && isBillingSource(sources[0]) ? sources[0] : 'UNKNOWN';
  const unit = units.length === 1 ? units[0] : undefined;
  const baseline: SavingsCostAggregate = {
    cost: Number(row[effectiveUsable ? 'baseline_effective' : 'baseline_billed'] ?? 0),
    coveredDays: Number(row['baseline_days'] ?? 0),
    sampleCount: Number(row['baseline_count'] ?? 0),
    ...(Number(row['baseline_quantity'] ?? 0) !== 0 ? { quantity: Number(row['baseline_quantity']) } : {}),
    ...(unit !== undefined ? { unit } : {}),
  };
  const observation: SavingsCostAggregate = {
    cost: Number(row[effectiveUsable ? 'observation_effective' : 'observation_billed'] ?? 0),
    coveredDays: Number(row['observation_days'] ?? 0),
    sampleCount: Number(row['observation_count'] ?? 0),
    ...(Number(row['observation_quantity'] ?? 0) !== 0 ? { quantity: Number(row['observation_quantity']) } : {}),
    ...(unit !== undefined ? { unit } : {}),
  };
  const reasons: string[] = [];
  if (context.scope === 'UNKNOWN') reasons.push('La evidencia no permite reconstruir un recurso, servicio o cuenta cloud exactos.');
  if (sources.length !== 1) reasons.push('La evidencia mezcla o no identifica una única fuente de facturación.');
  if (currencies.length !== 1) reasons.push('La evidencia mezcla o no identifica una única moneda.');
  if (connections.length !== 1) reasons.push('La evidencia mezcla o no identifica una única conexión cloud.');
  if (units.length > 1) reasons.push('La unidad de consumo no es consistente entre las ventanas.');
  const postWindowOpen = isPostWindowStillOpen(context.observationEnd, observation.coveredDays, context.windowDays);
  const technicalEvidence = context.scope === 'RESOURCE' && context.resourceId !== undefined && connections.length === 1
    ? await readTechnicalEvidence(prisma, context, connections[0]!)
    : { sampleCount: 0, criticalSignal: false, available: false };
  if (context.technicalEvidenceRequired && !technicalEvidence.available) {
    reasons.push('La evidencia técnica posterior no tiene CPU y memoria con cobertura suficiente (48 muestras y 7 días).');
  }
  if (context.technicalEvidenceRequired && technicalEvidence.criticalSignal) {
    reasons.push('La evidencia técnica contiene señales de saturación; no es seguro afirmar que la optimización mantuvo el servicio estable.');
  }
  const technicalInsufficient = context.technicalEvidenceRequired && (!technicalEvidence.available || technicalEvidence.criticalSignal);
  const scopeInsufficient = context.scope === 'UNKNOWN';
  const status: SavingsMeasurementReadiness['status'] = postWindowOpen
    ? scopeInsufficient ? 'INSUFFICIENT_EVIDENCE' : 'WAITING_FOR_DATA'
    : sources.length === 1 && currencies.length === 1 && connections.length === 1 && !technicalInsufficient && !scopeInsufficient
      ? 'READY' : 'INSUFFICIENT_EVIDENCE';
  return {
    baseline,
    observation,
    billingSource,
    ...(costBasis !== undefined ? { costBasis } : {}),
    billingSources: sources,
    currencies,
    cloudConnectionIds: connections,
    technicalSampleCount: technicalEvidence.sampleCount,
    technicalEvidenceAvailable: technicalEvidence.available,
    technicalCriticalSignal: technicalEvidence.criticalSignal,
    ...(unit !== undefined ? { unit } : {}),
    status,
    reasons,
    ...(row['available_through'] instanceof Date ? { availableThrough: row['available_through'] } : {}),
  };
}

export function isPostWindowStillOpen(observationEnd: Date, observationCoveredDays: number, windowDays: number): boolean {
  return Date.now() < observationEnd.getTime() && observationCoveredDays < windowDays;
}

async function readTechnicalEvidence(
  prisma: PrismaClient,
  context: MeasurementContext,
  cloudConnectionId: string,
): Promise<{ readonly sampleCount: number; readonly criticalSignal: boolean; readonly available: boolean }> {
  const rows = await prisma.$queryRaw<Array<{
    readonly normalized_name: string;
    readonly sample_count: bigint;
    readonly coverage_days: number;
    readonly p95: number | null;
    readonly p99: number | null;
    readonly high_ratio: number | null;
  }>>(Prisma.sql`
    SELECT
      lower(regexp_replace(metric_name, '[^a-zA-Z0-9]', '', 'g')) AS normalized_name,
      count(*)::bigint AS sample_count,
      count(DISTINCT (sampled_at AT TIME ZONE 'UTC')::date)::int AS coverage_days,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY value::double precision)::float8 AS p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY value::double precision)::float8 AS p99,
      (count(*) FILTER (WHERE value >= 80)::double precision / NULLIF(count(*), 0))::float8 AS high_ratio
    FROM resource_metric_samples
    WHERE tenant_id = ${context.tenantId}
      AND cloud_connection_id = ${cloudConnectionId}
      AND external_resource_id = ${context.resourceId}
      AND sampled_at >= ${context.observationStart}
      AND sampled_at < ${context.observationEnd}
    GROUP BY lower(regexp_replace(metric_name, '[^a-zA-Z0-9]', '', 'g'))
  `);
  const cpu = rows.find((row) => row.normalized_name.includes('cpu'));
  const memory = rows.find((row) => row.normalized_name.includes('memory'));
  const sufficient = (row: typeof rows[number] | undefined): boolean => (
    row !== undefined && Number(row.sample_count) >= 48 && Number(row.coverage_days) >= 7
  );
  const criticalSignal = rows.some((row) => {
    const p95 = Number(row.p95 ?? 0);
    const p99 = Number(row.p99 ?? 0);
    const saturation = p95 >= 80 || Number(row.high_ratio ?? 0) >= 0.2;
    return (row.normalized_name.includes('cpu') && (saturation || p99 >= 90))
      || (row.normalized_name.includes('memory') && saturation)
      || (['network', 'disk', 'iops'].some((family) => row.normalized_name.includes(family)) && saturation);
  });
  return {
    sampleCount: rows.reduce((total, row) => total + Number(row.sample_count), 0),
    criticalSignal,
    available: sufficient(cpu) && sufficient(memory),
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()) : [];
}

function isBillingSource(value: string | undefined): value is 'FOCUS' | 'PROVIDER_API' | 'LEGACY' | 'UNKNOWN' {
  return value === 'FOCUS' || value === 'PROVIDER_API' || value === 'LEGACY' || value === 'UNKNOWN';
}

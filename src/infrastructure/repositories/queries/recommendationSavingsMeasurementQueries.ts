import { createHash } from 'node:crypto';
import type {
  CreateSavingsMeasurementInput,
  RecommendationSavingsMeasurement,
  RejectSavingsMeasurementInput,
  SavingsMeasurementReadiness,
  SavingsMeasurementScope,
  SavingsMeasurementStatus,
  VerifySavingsMeasurementInput,
} from '../../../domain/interfaces/IRecommendationRepository.js';
import { FinOpsBaseError } from '../../../domain/errors/errors.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { Prisma } from '../../../generated/prisma/client.js';
import {
  calculateDeterministicSavings,
  defaultSavingsWindowDays,
  type SavingsCostAggregate,
} from '../../../application/services/savings/DeterministicSavingsCalculator.js';

type MeasurementRow = Awaited<ReturnType<PrismaClient['recommendationSavingsMeasurement']['findFirst']>> & {};
type CloudProviderValue = 'AWS' | 'OCI' | 'AZURE' | 'GCP' | 'CUSTOM';

const allowedWindowDays = new Set([7, 14, 30]);

export async function getSavingsMeasurementReadiness(
  prisma: PrismaClient,
  tenantId: string,
  recommendationId: string,
): Promise<SavingsMeasurementReadiness> {
  const context = await loadContext(prisma, tenantId, recommendationId);
  if (context === null) {
    return {
      recommendationId,
      status: 'NO_EXECUTION',
      windowDays: defaultSavingsWindowDays,
      reasons: ['La recomendación no tiene una ejecución manual medible en este tenant.'],
    };
  }

  const readiness = await readAggregate(prisma, context);
  const reasons = [...readiness.reasons];
  let status: SavingsMeasurementReadiness['status'] = readiness.status;
  if (context.manualExecution.executedAt === null) {
    status = 'NO_EXECUTION';
    reasons.unshift('La ejecución aún no tiene fecha de ejecución.');
  }

  return {
    recommendationId,
    manualExecutionId: context.manualExecution.id,
    status,
    windowDays: context.windowDays,
    baselineStart: context.baselineStart,
    baselineEnd: context.baselineEnd,
    observationStart: context.observationStart,
    observationEnd: context.observationEnd,
    ...(readiness.availableThrough !== undefined ? { availableThrough: readiness.availableThrough } : {}),
    reasons,
  };
}

export async function createSavingsMeasurement(
  prisma: PrismaClient,
  input: CreateSavingsMeasurementInput,
): Promise<RecommendationSavingsMeasurement> {
  const context = await loadContext(
    prisma,
    input.tenantId,
    input.recommendationId,
    input.manualExecutionId,
    normalizeWindowDays(input.windowDays),
  );
  if (context === null) {
    throw new SavingsMeasurementError('No se encontró la ejecución manual para esta recomendación', 'NOT_FOUND');
  }
  if (context.manualExecution.executedAt === null) {
    throw new SavingsMeasurementError('La ejecución manual debe tener fecha de ejecución antes de medir el ahorro', 'VALIDATION_ERROR');
  }
  if (!['EXECUTED', 'PARTIAL'].includes(context.manualExecution.status)) {
    throw new SavingsMeasurementError('Solo se pueden medir ejecuciones ejecutadas o parciales', 'VALIDATION_ERROR');
  }

  const existingVerified = await prisma.recommendationSavingsMeasurement.findFirst({
    where: { tenantId: input.tenantId, manualExecutionId: input.manualExecutionId, status: 'VERIFIED' },
    orderBy: { createdAt: 'desc' },
  });
  if (existingVerified !== null) return toDomain(existingVerified);

  const aggregate = await readAggregate(prisma, context);
  const result = calculateDeterministicSavings({
    scope: context.scope,
    windowDays: context.windowDays,
    baseline: aggregate.baseline,
    observation: aggregate.observation,
    technicalSampleCount: aggregate.technicalSampleCount,
    technicalEvidenceRequired: context.technicalEvidenceRequired,
    technicalEvidenceAvailable: aggregate.technicalEvidenceAvailable,
    technicalCriticalSignal: aggregate.technicalCriticalSignal,
  });
  const status = isPostWindowStillOpen(context.observationEnd, aggregate.observation.coveredDays, context.windowDays)
    ? 'WAITING_FOR_DATA'
    : aggregate.status === 'INSUFFICIENT_EVIDENCE' ? 'INSUFFICIENT_EVIDENCE' : result.status;
  const measurementReasons = [...aggregate.reasons, ...result.reasons];
  const costBasis = aggregate.costBasis;
  const evidence = {
    scope: context.scope,
    provider: context.provider,
    cloudAccountId: context.cloudAccountId,
    cloudConnectionIds: aggregate.cloudConnectionIds,
    billingSources: aggregate.billingSources,
    currencies: aggregate.currencies,
    source: 'cost_metrics',
    technicalSampleCount: aggregate.technicalSampleCount,
    technicalEvidenceRequired: context.technicalEvidenceRequired,
    baselineSampleCount: aggregate.baseline.sampleCount,
    observationSampleCount: aggregate.observation.sampleCount,
    readinessStatus: aggregate.status,
  };
  const hashInput = {
    manualExecutionId: input.manualExecutionId,
    recommendationId: input.recommendationId,
    baselineStart: context.baselineStart.toISOString(),
    baselineEnd: context.baselineEnd.toISOString(),
    observationStart: context.observationStart.toISOString(),
    observationEnd: context.observationEnd.toISOString(),
    aggregate,
    result,
  };
  const evidenceHash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
  const duplicate = await prisma.recommendationSavingsMeasurement.findUnique({
    where: { manualExecutionId_evidenceHash: { manualExecutionId: input.manualExecutionId, evidenceHash } },
  });
  if (duplicate !== null) return toDomain(duplicate);

  const row = await prisma.recommendationSavingsMeasurement.create({
    data: {
      tenantId: input.tenantId,
      recommendationId: input.recommendationId,
      manualExecutionId: input.manualExecutionId,
      ...(context.manualExecution.executionPlanId !== null
        ? { executionPlanId: context.manualExecution.executionPlanId }
        : input.executionPlanId !== undefined ? { executionPlanId: input.executionPlanId } : {}),
      requestedByUserId: input.requestedByUserId,
      status,
      scope: context.scope,
      provider: context.provider as CloudProviderValue,
      cloudAccountId: context.cloudAccountId,
      ...(context.resourceId !== undefined ? { resourceId: context.resourceId } : {}),
      ...(context.serviceName !== undefined ? { serviceName: context.serviceName } : {}),
      executedAt: context.manualExecution.executedAt,
      baselineStart: context.baselineStart,
      baselineEnd: context.baselineEnd,
      observationStart: context.observationStart,
      observationEnd: context.observationEnd,
      windowDays: context.windowDays,
      baselineCoveredDays: aggregate.baseline.coveredDays,
      observationCoveredDays: aggregate.observation.coveredDays,
      coverageRatio: result.coverageRatio,
      billingSource: aggregate.billingSource,
      ...(costBasis !== undefined ? { costBasis } : {}),
      currency: context.currency,
      ...(result.baselineDailyCost !== undefined ? { baselineDailyCost: result.baselineDailyCost } : {}),
      ...(result.observationDailyCost !== undefined ? { observationDailyCost: result.observationDailyCost } : {}),
      ...(aggregate.baseline.cost !== undefined ? { baselineCost: aggregate.baseline.cost } : {}),
      ...(aggregate.observation.cost !== undefined ? { observationCost: aggregate.observation.cost } : {}),
      ...(result.observedSavings !== undefined ? { observedSavings: result.observedSavings } : {}),
      ...(result.projectedMonthlySavings !== undefined ? { projectedMonthlySavings: result.projectedMonthlySavings } : {}),
      ...(result.costIncreaseMonthlyAmount !== undefined ? { costIncreaseMonthlyAmount: result.costIncreaseMonthlyAmount } : {}),
      ...(aggregate.baseline.quantity !== undefined ? { baselineQuantity: aggregate.baseline.quantity } : {}),
      ...(aggregate.observation.quantity !== undefined ? { observationQuantity: aggregate.observation.quantity } : {}),
      ...(aggregate.unit !== undefined ? { consumedUnit: aggregate.unit } : {}),
      calculationMethod: result.calculationMethod,
      ...(result.baselineUnitCost !== undefined ? { baselineUnitCost: result.baselineUnitCost } : {}),
      ...(result.observationUnitCost !== undefined ? { observationUnitCost: result.observationUnitCost } : {}),
      ...(result.quantityChangeRatio !== undefined ? { quantityChangeRatio: result.quantityChangeRatio } : {}),
      confidence: result.confidence,
      confidenceLevel: result.confidenceLevel,
      technicalValidationStatus: result.technicalValidationStatus,
      reasons: measurementReasons as unknown as Prisma.InputJsonValue,
      formula: result.formula as unknown as Prisma.InputJsonValue,
      evidence: evidence as unknown as Prisma.InputJsonValue,
      evidenceHash,
      calculationVersion: result.formula.version,
      ...(status === 'CALCULATED' || status === 'INSUFFICIENT_EVIDENCE'
        ? { calculatedAt: new Date() }
        : {}),
    },
  });
  return toDomain(row);
}

export async function findSavingsMeasurementsByRecommendation(
  prisma: PrismaClient,
  tenantId: string,
  recommendationId: string,
): Promise<RecommendationSavingsMeasurement[]> {
  const rows = await prisma.recommendationSavingsMeasurement.findMany({
    where: { tenantId, recommendationId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toDomain);
}

export async function findSavingsMeasurementById(
  prisma: PrismaClient,
  tenantId: string,
  recommendationId: string,
  measurementId: string,
): Promise<RecommendationSavingsMeasurement | null> {
  const row = await prisma.recommendationSavingsMeasurement.findFirst({
    where: { id: measurementId, tenantId, recommendationId },
  });
  return row === null ? null : toDomain(row);
}

export async function verifySavingsMeasurement(
  prisma: PrismaClient,
  input: VerifySavingsMeasurementInput,
): Promise<RecommendationSavingsMeasurement> {
  const row = await prisma.recommendationSavingsMeasurement.findFirst({
    where: { id: input.measurementId, tenantId: input.tenantId, recommendationId: input.recommendationId },
  });
  if (row === null) throw new SavingsMeasurementError('No se encontró la medición de ahorro', 'NOT_FOUND');
  if (row.status === 'VERIFIED') return toDomain(row);
  if (row.status !== 'CALCULATED') {
    throw new SavingsMeasurementError('Solo se puede verificar una medición calculada', 'VALIDATION_ERROR');
  }
  if (Number(row.projectedMonthlySavings ?? 0) < 0) {
    throw new SavingsMeasurementError('Un aumento de costo no se puede verificar como ahorro', 'VALIDATION_ERROR');
  }
  const evidence = asRecord(row.evidence);
  if (evidence['technicalEvidenceRequired'] === true && row.technicalValidationStatus !== 'AVAILABLE') {
    throw new SavingsMeasurementError('Se requiere evidencia técnica suficiente antes de verificar', 'INSUFFICIENT_EVIDENCE');
  }
  const updated = await prisma.recommendationSavingsMeasurement.update({
    where: { id: input.measurementId },
    data: {
      status: 'VERIFIED',
      verifiedByUserId: input.userId,
      verifiedAt: new Date(),
      ...(input.note !== undefined ? { verificationNote: input.note } : {}),
    },
  });
  return toDomain(updated);
}

export async function rejectSavingsMeasurement(
  prisma: PrismaClient,
  input: RejectSavingsMeasurementInput,
): Promise<RecommendationSavingsMeasurement> {
  const row = await prisma.recommendationSavingsMeasurement.findFirst({
    where: { id: input.measurementId, tenantId: input.tenantId, recommendationId: input.recommendationId },
  });
  if (row === null) throw new SavingsMeasurementError('No se encontró la medición de ahorro', 'NOT_FOUND');
  if (row.status === 'VERIFIED') {
    throw new SavingsMeasurementError('Una medición verificada es inmutable', 'VALIDATION_ERROR');
  }
  const updated = await prisma.recommendationSavingsMeasurement.update({
    where: { id: input.measurementId },
    data: { status: 'REJECTED', verifiedByUserId: input.userId, rejectionReason: input.reason },
  });
  return toDomain(updated);
}

export function toDomain(row: MeasurementRow): RecommendationSavingsMeasurement {
  return {
    id: row.id,
    tenantId: row.tenantId,
    recommendationId: row.recommendationId,
    manualExecutionId: row.manualExecutionId,
    ...(row.executionPlanId !== null ? { executionPlanId: row.executionPlanId } : {}),
    requestedByUserId: row.requestedByUserId,
    ...(row.verifiedByUserId !== null ? { verifiedByUserId: row.verifiedByUserId } : {}),
    status: row.status,
    scope: row.scope,
    provider: row.provider,
    cloudAccountId: row.cloudAccountId,
    ...(row.resourceId !== null ? { resourceId: row.resourceId } : {}),
    ...(row.serviceName !== null ? { serviceName: row.serviceName } : {}),
    executedAt: row.executedAt,
    baselineStart: row.baselineStart,
    baselineEnd: row.baselineEnd,
    observationStart: row.observationStart,
    observationEnd: row.observationEnd,
    windowDays: row.windowDays,
    baselineCoveredDays: row.baselineCoveredDays,
    observationCoveredDays: row.observationCoveredDays,
    coverageRatio: Number(row.coverageRatio),
    billingSource: row.billingSource,
    ...(row.costBasis === 'EFFECTIVE' || row.costBasis === 'BILLED' ? { costBasis: row.costBasis } : {}),
    currency: row.currency,
    ...(row.baselineCost !== null ? { baselineCost: Number(row.baselineCost) } : {}),
    ...(row.observationCost !== null ? { observationCost: Number(row.observationCost) } : {}),
    ...(row.baselineDailyCost !== null ? { baselineDailyCost: Number(row.baselineDailyCost) } : {}),
    ...(row.observationDailyCost !== null ? { observationDailyCost: Number(row.observationDailyCost) } : {}),
    ...(row.observedSavings !== null ? { observedSavings: Number(row.observedSavings) } : {}),
    ...(row.projectedMonthlySavings !== null ? { projectedMonthlySavings: Number(row.projectedMonthlySavings) } : {}),
    ...(row.costIncreaseMonthlyAmount !== null ? { costIncreaseMonthlyAmount: Number(row.costIncreaseMonthlyAmount) } : {}),
    ...(row.baselineQuantity !== null ? { baselineQuantity: Number(row.baselineQuantity) } : {}),
    ...(row.observationQuantity !== null ? { observationQuantity: Number(row.observationQuantity) } : {}),
    ...(row.consumedUnit !== null ? { consumedUnit: row.consumedUnit } : {}),
    calculationMethod: row.calculationMethod as 'COST_DELTA' | 'UNIT_NORMALIZED',
    ...(row.baselineUnitCost !== null ? { baselineUnitCost: Number(row.baselineUnitCost) } : {}),
    ...(row.observationUnitCost !== null ? { observationUnitCost: Number(row.observationUnitCost) } : {}),
    ...(row.quantityChangeRatio !== null ? { quantityChangeRatio: Number(row.quantityChangeRatio) } : {}),
    ...(row.confidence !== null ? { confidence: Number(row.confidence) } : {}),
    ...(row.confidenceLevel !== null ? { confidenceLevel: row.confidenceLevel } : {}),
    technicalValidationStatus: row.technicalValidationStatus,
    reasons: readStringArray(row.reasons),
    formula: row.formula,
    evidence: row.evidence,
    evidenceHash: row.evidenceHash,
    calculationVersion: row.calculationVersion,
    ...(row.verificationNote !== null ? { verificationNote: row.verificationNote } : {}),
    ...(row.rejectionReason !== null ? { rejectionReason: row.rejectionReason } : {}),
    ...(row.calculatedAt !== null ? { calculatedAt: row.calculatedAt } : {}),
    ...(row.verifiedAt !== null ? { verifiedAt: row.verifiedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class SavingsMeasurementError extends FinOpsBaseError {
  constructor(message: string, code: string) {
    super(message, code);
  }
}

interface MeasurementContext {
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

async function loadContext(
  prisma: PrismaClient,
  tenantId: string,
  recommendationId: string,
  manualExecutionId?: string,
  windowDays = defaultSavingsWindowDays,
): Promise<MeasurementContext | null> {
  const recommendation = await prisma.recommendation.findFirst({
    where: { tenantId, id: recommendationId },
    include: {
      cloudAccount: true,
      manualExecutions: {
        orderBy: { createdAt: 'desc' },
        ...(manualExecutionId !== undefined ? { where: { id: manualExecutionId } } : {}),
      },
    },
  });
  if (recommendation === null) return null;
  const execution = recommendation.manualExecutions[0];
  if (execution === undefined) return null;
  const evidence = asRecord(recommendation.evidence);
  const resource = firstResource(evidence);
  const resourceId = readString(evidence['externalResourceId']) ?? readString(evidence['resourceId']) ?? resource?.externalResourceId;
  const serviceName = readString(evidence['serviceName']) ?? resource?.serviceName;
  const explicitScope = readString(evidence['scope'])?.toUpperCase();
  const scope: SavingsMeasurementScope = resourceId !== undefined
    ? 'RESOURCE'
    : serviceName !== undefined || explicitScope === 'SERVICE' ? 'SERVICE'
      : explicitScope === 'ACCOUNT' || evidence['accountScope'] === true ? 'ACCOUNT' : 'UNKNOWN';
  const executedAt = execution.executedAt;
  const executionDay = executedAt === null ? startOfUtcDay(new Date()) : startOfUtcDay(executedAt);
  return {
    tenantId,
    recommendationId,
    manualExecution: {
      id: execution.id,
      status: execution.status,
      executedAt,
      executionPlanId: execution.executionPlanId,
    },
    provider: recommendation.cloudAccount.provider as CloudProviderValue,
    cloudAccountId: recommendation.cloudAccountId,
    currency: recommendation.currency,
    scope,
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(serviceName !== undefined ? { serviceName } : {}),
    technicalEvidenceRequired: evidence['requiresTechnicalValidation'] === true || resourceId !== undefined,
    windowDays,
    baselineStart: addUtcDays(executionDay, -windowDays),
    baselineEnd: executionDay,
    observationStart: addUtcDays(executionDay, 1),
    observationEnd: addUtcDays(executionDay, 1 + windowDays),
  };
}

interface AggregateResult {
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

async function readAggregate(prisma: PrismaClient, context: MeasurementContext): Promise<AggregateResult & { readonly status: SavingsMeasurementReadiness['status']; readonly reasons: readonly string[]; readonly availableThrough?: Date }> {
  const scopeClause = context.scope === 'RESOURCE'
    ? Prisma.sql`AND resource_id = ${context.resourceId}`
    : context.scope === 'SERVICE'
      ? Prisma.sql`AND service_name = ${context.serviceName}`
      : context.scope === 'ACCOUNT'
        ? Prisma.empty
        : Prisma.sql`AND FALSE`;
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
  const effectiveUsable = Number(row['effective_null_count'] ?? 0) === 0 &&
    Number(row['baseline_count'] ?? 0) + Number(row['observation_count'] ?? 0) > 0;
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
  const technicalSampleCount = technicalEvidence.sampleCount;
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
    technicalSampleCount,
    technicalEvidenceAvailable: technicalEvidence.available,
    technicalCriticalSignal: technicalEvidence.criticalSignal,
    ...(unit !== undefined ? { unit } : {}),
    status,
    reasons,
    ...(row['available_through'] instanceof Date ? { availableThrough: row['available_through'] } : {}),
  };
}

async function readTechnicalEvidence(
  prisma: PrismaClient,
  context: MeasurementContext,
  cloudConnectionId: string,
): Promise<{
  readonly sampleCount: number;
  readonly criticalSignal: boolean;
  readonly available: boolean;
}> {
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
  const sufficient = (row: typeof rows[number] | undefined): boolean =>
    row !== undefined && Number(row.sample_count) >= 48 && Number(row.coverage_days) >= 7;
  const critical = rows.some((row) => {
    const name = row.normalized_name;
    const p95 = Number(row.p95 ?? 0);
    const p99 = Number(row.p99 ?? 0);
    const highRatio = Number(row.high_ratio ?? 0);
    const saturation = p95 >= 80 || highRatio >= 0.2;
    return (name.includes('cpu') && (saturation || p99 >= 90)) ||
      (name.includes('memory') && saturation) ||
      (['network', 'disk', 'iops'].some((family) => name.includes(family)) && saturation);
  });
  return {
    sampleCount: rows.reduce((total, row) => total + Number(row.sample_count), 0),
    criticalSignal: critical,
    available: sufficient(cpu) && sufficient(memory),
  };
}

function isPostWindowStillOpen(observationEnd: Date, observationCoveredDays: number, windowDays: number): boolean {
  return Date.now() < observationEnd.getTime() && observationCoveredDays < windowDays;
}

function inferResources(evidence: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(evidence['resources'])
    ? evidence['resources'].filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function firstResource(evidence: Record<string, unknown>): { externalResourceId?: string; serviceName?: string } | undefined {
  const resource = inferResources(evidence)[0];
  if (resource === undefined) return undefined;
  const externalResourceId = readString(resource['externalResourceId']);
  const serviceName = readString(resource['serviceName']);
  const result: { externalResourceId?: string; serviceName?: string } = {};
  if (externalResourceId !== undefined) result.externalResourceId = externalResourceId;
  if (serviceName !== undefined) result.serviceName = serviceName;
  return result;
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readString).filter((item): item is string => item !== undefined) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBillingSource(value: string | undefined): value is 'FOCUS' | 'PROVIDER_API' | 'LEGACY' | 'UNKNOWN' {
  return value === 'FOCUS' || value === 'PROVIDER_API' || value === 'LEGACY' || value === 'UNKNOWN';
}

function normalizeWindowDays(value: number | undefined): number {
  const normalized = value ?? defaultSavingsWindowDays;
  if (!Number.isInteger(normalized) || !allowedWindowDays.has(normalized)) {
    throw new SavingsMeasurementError('windowDays debe ser 7, 14 o 30', 'VALIDATION_ERROR');
  }
  return normalized;
}

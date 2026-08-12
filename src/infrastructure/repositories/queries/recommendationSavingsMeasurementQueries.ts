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
} from '../../../application/services/savings/DeterministicSavingsCalculator.js';
import {
  isPostWindowStillOpen,
  readSavingsAggregate,
  type CloudProviderValue,
  type MeasurementContext,
} from './savingsMeasurementEvidenceQueries.js';
import { toSavingsMeasurementDomain } from './savingsMeasurementMapping.js';

type MeasurementRow = Awaited<ReturnType<PrismaClient['recommendationSavingsMeasurement']['findFirst']>> & {};

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

  const readiness = await readSavingsAggregate(prisma, context);
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

  const aggregate = await readSavingsAggregate(prisma, context);
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

export const toDomain = toSavingsMeasurementDomain;

class SavingsMeasurementError extends FinOpsBaseError {
  constructor(message: string, code: string) {
    super(message, code);
  }
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

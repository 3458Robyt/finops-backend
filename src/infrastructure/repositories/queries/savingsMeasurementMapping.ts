import type { RecommendationSavingsMeasurement } from '../../../domain/interfaces/IRecommendationRepository.js';

type MeasurementRow = Awaited<ReturnType<import('../../../generated/prisma/client.js').PrismaClient['recommendationSavingsMeasurement']['findFirst']>> & {};

/** Maps persisted savings measurements to the domain contract without query concerns. */
export function toSavingsMeasurementDomain(row: MeasurementRow): RecommendationSavingsMeasurement {
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

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

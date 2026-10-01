import type { SavingsKpis } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';
import { hasApprovedSavings, hasPotentialSavings } from '../../../domain/models/recommendationEconomics.js';
import {
  CurrencyConverter,
  type CurrencyAmountProjection,
  type CurrencyAmountInput,
  normalizeCurrencyCode,
} from '../../finance/CurrencyConverter.js';
import { calculateMissedSavings, roundCurrency } from '../mappers/recommendationMappers.js';

type MonetaryRow = CurrencyAmountInput;
type ProjectedRow<T> = { readonly row: T; readonly projection: CurrencyAmountProjection };

/** Computes recommendation savings KPIs in the tenant reporting currency. */
export async function computeProjectedSavingsKpis(
  prisma: PrismaClient,
  tenantId: string,
  reportingCurrency: string,
  converter: CurrencyConverter,
): Promise<SavingsKpis> {
  const [recommendations, executions, measurements, executedGroups] = await Promise.all([
    prisma.recommendation.findMany({
      where: { tenantId },
      select: { id: true, title: true, estimatedMonthlySavings: true, currency: true, status: true, evidence: true, createdAt: true },
    }),
    prisma.recommendationManualExecution.findMany({
      where: { tenantId, status: { in: ['EXECUTED', 'PARTIAL'] } },
      select: { observedMonthlySavings: true, currency: true, createdAt: true },
    }),
    prisma.recommendationSavingsMeasurement.findMany({
      where: { tenantId, status: { in: ['CALCULATED', 'VERIFIED'] } },
      select: { projectedMonthlySavings: true, costIncreaseMonthlyAmount: true, currency: true, createdAt: true, status: true },
    }),
    prisma.recommendationManualExecution.groupBy({
      by: ['recommendationId'],
      where: { tenantId, status: { in: ['EXECUTED', 'PARTIAL'] } },
    }),
  ]);

  const target = normalizeCurrencyCode(reportingCurrency);
  const potentialRecommendations = recommendations.filter(hasPotentialSavings);
  const approvedRecommendations = recommendations.filter(hasApprovedSavings);
  const estimateRows = potentialRecommendations.flatMap((row) => row.estimatedMonthlySavings === null
    ? []
    : [{ row, amount: Number(row.estimatedMonthlySavings), currency: row.currency, at: row.createdAt }]);
  const approvedRows = approvedRecommendations.flatMap((row) => row.estimatedMonthlySavings === null
    ? []
    : [{ row, amount: Number(row.estimatedMonthlySavings), currency: row.currency, at: row.createdAt }]);
  const reportedRows = executions.flatMap((row) => row.observedMonthlySavings === null
    ? []
    : [{ row, amount: Number(row.observedMonthlySavings), currency: row.currency, at: row.createdAt }]);
  const observedRows = measurements.flatMap((row) => row.projectedMonthlySavings === null || Number(row.projectedMonthlySavings) <= 0
    ? []
    : [{ row, amount: Number(row.projectedMonthlySavings), currency: row.currency, at: row.createdAt }]);
  const verifiedRows = measurements.flatMap((row) => row.status !== 'VERIFIED' || row.projectedMonthlySavings === null || Number(row.projectedMonthlySavings) <= 0
    ? []
    : [{ row, amount: Number(row.projectedMonthlySavings), currency: row.currency, at: row.createdAt }]);
  const increaseRows = measurements.flatMap((row) => row.costIncreaseMonthlyAmount === null || Number(row.costIncreaseMonthlyAmount) <= 0
    ? []
    : [{ row, amount: Number(row.costIncreaseMonthlyAmount), currency: row.currency, at: row.createdAt }]);

  const [estimates, approved, reported, observed, verified, increases] = await Promise.all([
    projectRows(estimateRows, target, converter),
    projectRows(approvedRows, target, converter),
    projectRows(reportedRows, target, converter),
    projectRows(observedRows, target, converter),
    projectRows(verifiedRows, target, converter),
    projectRows(increaseRows, target, converter),
  ]);
  const conversionIssueCount = [estimates, reported, observed, verified, increases]
    .reduce((total, rows) => total + rows.filter((item) => item.projection.amount === null).length, 0);

  const pendingRows = potentialRecommendations;
  const pendingProjected = await projectRows(
    pendingRows.map((row) => ({ row, amount: Number(row.estimatedMonthlySavings), currency: row.currency, at: row.createdAt })),
    target,
    converter,
  );
  const missedSavings = pendingProjected
    .flatMap((item) => item.projection.amount === null
      ? []
      : [{ recommendation: item.row.row, projectedMonthlySavings: item.projection.amount, missedSavingsAmount: calculateMissedSavings(item.projection.amount, item.row.row.createdAt) }])
    .filter((item) => item.missedSavingsAmount > 0.01)
    .sort((left, right) => right.missedSavingsAmount - left.missedSavingsAmount);
  const topMissed = missedSavings[0];

  return {
    estimatedMonthlySavings: sumProjections(estimates),
    approvedMonthlySavings: sumProjections(approved),
    observedMonthlySavings: sumProjections(observed),
    userReportedMonthlySavings: sumProjections(reported),
    verifiedMonthlySavings: sumProjections(verified),
    costIncreaseMonthlyAmount: sumProjections(increases),
    confirmedMonthlySavings: sumProjections(verified),
    missedSavingsAmount: roundCurrency(missedSavings.reduce((total, item) => total + item.missedSavingsAmount, 0)),
    currency: target,
    executedRecommendations: executedGroups.length,
    pendingSavingsRecommendations: pendingRows.length,
    ...(conversionIssueCount === 0 ? {} : { conversionIssueCount }),
    ...(topMissed === undefined ? {} : {
      topMissedSavingsRecommendation: {
        id: topMissed.recommendation.id,
        title: topMissed.recommendation.title,
        missedSavingsAmount: topMissed.missedSavingsAmount,
        estimatedMonthlySavings: topMissed.projectedMonthlySavings,
        currency: target,
        createdAt: topMissed.recommendation.createdAt,
        status: topMissed.recommendation.status,
      },
    }),
  };
}

async function projectRows<T>(
  rows: readonly (T & MonetaryRow)[],
  reportingCurrency: string,
  converter: CurrencyConverter,
): Promise<readonly ProjectedRow<T>[]> {
  const projections = await converter.convertMany(rows, reportingCurrency);
  return rows.map((row, index) => ({ row: row as T, projection: projections[index]! }));
}

function sumProjections(rows: readonly ProjectedRow<unknown>[]): number {
  return roundCurrency(rows.reduce((total, item) => total + (item.projection.amount ?? 0), 0));
}

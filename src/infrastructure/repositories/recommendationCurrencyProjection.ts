import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { CurrencyConverter, normalizeCurrencyCode } from '../finance/CurrencyConverter.js';
import { toDomain } from './mappers/recommendationMappers.js';

export type RecommendationRow = Awaited<ReturnType<PrismaClient['recommendation']['findFirst']>> & {};

export async function projectRecommendations(
  prisma: PrismaClient,
  currencyConverter: CurrencyConverter | undefined,
  rows: readonly RecommendationRow[],
): Promise<FinOpsRecommendation[]> {
  if (currencyConverter === undefined || rows.length === 0) return rows.map((row) => toDomain(row));

  const tenantIds = [...new Set(rows.map((row) => row.tenantId))];
  const reportingCurrencies = new Map(
    await Promise.all(
      tenantIds.map(async (tenantId) => [tenantId, await getReportingCurrency(prisma, tenantId)] as const),
    ),
  );
  return Promise.all(rows.map((row) => projectRecommendation(
    prisma,
    currencyConverter,
    row,
    reportingCurrencies.get(row.tenantId),
  )));
}

export async function projectRecommendation(
  prisma: PrismaClient,
  currencyConverter: CurrencyConverter | undefined,
  row: RecommendationRow,
  reportingCurrency?: string,
): Promise<FinOpsRecommendation> {
  const recommendation = toDomain(row);
  if (currencyConverter === undefined || recommendation.estimatedMonthlySavings === undefined) return recommendation;

  const target = reportingCurrency ?? await getReportingCurrency(prisma, row.tenantId);
  const [projection] = await currencyConverter.convertMany([
    {
      amount: recommendation.estimatedMonthlySavings,
      currency: recommendation.currency,
      at: recommendation.createdAt,
    },
  ], target);
  if (projection === undefined || projection.status === 'NOT_REQUIRED') return recommendation;

  const native = {
    nativeEstimatedMonthlySavings: recommendation.estimatedMonthlySavings,
    nativeCurrency: recommendation.currency,
    conversionStatus: projection.status,
  } as const;
  if (projection.amount === null) return { ...recommendation, ...native };
  return {
    ...recommendation,
    estimatedMonthlySavings: projection.amount,
    currency: normalizeCurrencyCode(target),
    ...native,
  };
}

async function getReportingCurrency(prisma: PrismaClient, tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { reportingCurrency: true },
  });
  return normalizeCurrencyCode(tenant?.reportingCurrency ?? 'USD');
}

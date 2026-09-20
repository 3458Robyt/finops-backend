/** Economic eligibility rules shared by savings KPIs and executive summaries. */
export interface RecommendationEconomicInput {
  readonly status: string;
  readonly estimatedMonthlySavings?: unknown;
  readonly evidence?: unknown;
}

export function isFinancialReviewEvidence(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return evidence['reviewScope'] === 'FINANCIAL' || evidence['financialReviewOnly'] === true;
}

export function hasPotentialSavings(input: RecommendationEconomicInput): boolean {
  return (input.status === 'PENDING' || input.status === 'APPROVED')
    && !isFinancialReviewEvidence(input.evidence)
    && isPositive(input.estimatedMonthlySavings);
}

export function hasApprovedSavings(input: RecommendationEconomicInput): boolean {
  return (input.status === 'APPROVED' || input.status === 'MANUAL_COMPLETED')
    && !isFinancialReviewEvidence(input.evidence)
    && isPositive(input.estimatedMonthlySavings);
}

function isPositive(value: unknown): boolean {
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) && amount > 0;
}

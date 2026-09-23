/** Economic eligibility rules shared by savings KPIs and executive summaries. */
export interface RecommendationEconomicInput {
  readonly status: string;
  readonly estimatedMonthlySavings?: unknown;
  readonly currency?: string;
  readonly evidence?: unknown;
}

export interface VerifiedSavingsCalculation {
  readonly provenance: 'SERVER_DETERMINISTIC';
  readonly version: 'priced-alternative/v1';
  readonly status: 'CALCULATED';
  readonly formula: 'BASELINE_MINUS_ALTERNATIVE_MONTHLY';
  readonly baselineMonthlyCost: number;
  readonly alternativeMonthlyCost: number;
  readonly amount: number;
  readonly currency: string;
  readonly priceEvidenceRef: string;
}

export function isFinancialReviewEvidence(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return evidence['reviewScope'] === 'FINANCIAL' || evidence['financialReviewOnly'] === true;
}

export function hasPotentialSavings(input: RecommendationEconomicInput): boolean {
  return (input.status === 'PENDING' || input.status === 'APPROVED')
    && !isFinancialReviewEvidence(input.evidence)
    && isVerifiedSavingsCalculation(input.evidence, input.estimatedMonthlySavings, input.currency);
}

export function hasApprovedSavings(input: RecommendationEconomicInput): boolean {
  return (input.status === 'APPROVED' || input.status === 'MANUAL_COMPLETED')
    && !isFinancialReviewEvidence(input.evidence)
    && isVerifiedSavingsCalculation(input.evidence, input.estimatedMonthlySavings, input.currency);
}

/** Only a server-calculated, priced alternative can support a quantified estimate. */
export function isVerifiedSavingsCalculation(
  evidence: unknown,
  amount: unknown,
  currency: string | undefined,
): evidence is Record<string, unknown> {
  const rootAmount = positiveNumber(amount);
  const record = asRecord(evidence);
  const calculation = asRecord(record?.['savingsCalculation']);
  if (rootAmount === undefined || calculation === undefined || currency === undefined) return false;
  const baseline = positiveNumber(calculation['baselineMonthlyCost']);
  const alternative = positiveNumber(calculation['alternativeMonthlyCost']);
  const calculated = positiveNumber(calculation['amount']);
  const proofCurrency = typeof calculation['currency'] === 'string' ? calculation['currency'].trim().toUpperCase() : '';
  const priceEvidenceRef = typeof calculation['priceEvidenceRef'] === 'string' ? calculation['priceEvidenceRef'].trim() : '';

  return calculation['provenance'] === 'SERVER_DETERMINISTIC'
    && calculation['version'] === 'priced-alternative/v1'
    && calculation['status'] === 'CALCULATED'
    && calculation['formula'] === 'BASELINE_MINUS_ALTERNATIVE_MONTHLY'
    && proofCurrency === currency.trim().toUpperCase()
    && priceEvidenceRef.length > 0
    && baseline !== undefined
    && alternative !== undefined
    && calculated !== undefined
    && baseline > alternative
    && sameMoney(calculated, rootAmount)
    && sameMoney(baseline - alternative, rootAmount);
}

/** Remove legacy/LLM savings claims from API evidence without altering stored audit history. */
export function sanitizeSavingsEvidence(evidence: unknown, amount: unknown, currency: string): unknown {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return evidence;
  const record = evidence as Record<string, unknown>;
  const proofAmount = positiveNumber(amount)
    ?? positiveNumber(record['estimatedMonthlySavings'])
    ?? positiveNumber(record['potentialMonthlySavings']);
  const hasLegacyCap = positiveNumber(record['maxEstimatedMonthlySavings']) !== undefined
    || positiveNumber(record['potentialSavings']) !== undefined;
  if (proofAmount === undefined && !hasLegacyCap) return evidence;
  if (proofAmount !== undefined && isVerifiedSavingsCalculation(evidence, proofAmount, currency)) return evidence;

  const {
    potentialMonthlySavings: _potentialMonthlySavings,
    estimatedMonthlySavings: _estimatedMonthlySavings,
    potentialSavings: _potentialSavings,
    maxEstimatedMonthlySavings: _maxEstimatedMonthlySavings,
    savingsCalculation: _savingsCalculation,
    ...safeEvidence
  } = record;
  return { ...safeEvidence, savingsStatus: 'UNVERIFIED_LEGACY' };
}

function positiveNumber(value: unknown): number | undefined {
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function sameMoney(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.01;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

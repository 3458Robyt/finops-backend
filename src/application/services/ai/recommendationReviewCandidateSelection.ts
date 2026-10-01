import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { RecommendationOpportunityCandidate } from './RecommendationReadinessGate.js';
import { normalizeMonthlyAmount } from './recommendationReadinessSupport.js';

const maxReviewCandidates = 5;

export function selectTechnicalReviewCandidates(
  candidates: readonly RecommendationOpportunityCandidate[],
  snapshot: CostAnalyticsSnapshot,
): RecommendationOpportunityCandidate[] {
  const excludedIssues = new Set([
    'AMBIGUOUS_RESOURCE_LINK', 'STALE_COST', 'NO_CHARGEABLE_COST', 'EVIDENCE_QUERY_LIMIT_REACHED',
  ]);
  return candidates
    .filter((candidate) => candidate.resourceId !== undefined
      // ponytail: review-draft generation is Compute-only until service-specific technical rules exist.
      && /\b(compute|ec2|elastic compute cloud|virtual machines?)\b/i.test(candidate.serviceName)
      && candidate.cloudAccountId !== 'unknown-account'
      && candidate.observedCost !== undefined
      && Number.isFinite(candidate.observedCost)
      && candidate.observedCost > 0
      && !candidate.evidenceIssues?.some((issue) => excludedIssues.has(issue.code)))
    .sort((left, right) => {
      const signalDifference = Number((right.ruleMatches?.length ?? 0) > 0) - Number((left.ruleMatches?.length ?? 0) > 0);
      if (signalDifference !== 0) return signalDifference;
      const strength = (value: RecommendationOpportunityCandidate['evidenceStrength']): number =>
        value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : value === 'LOW' ? 1 : 0;
      const strengthDifference = strength(right.evidenceStrength) - strength(left.evidenceStrength);
      if (strengthDifference !== 0) return strengthDifference;
      const costDifference = normalizeMonthlyAmount(right.observedCost ?? 0, snapshot)
        - normalizeMonthlyAmount(left.observedCost ?? 0, snapshot);
      return costDifference !== 0 ? costDifference : left.id.localeCompare(right.id);
    })
    .slice(0, maxReviewCandidates);
}

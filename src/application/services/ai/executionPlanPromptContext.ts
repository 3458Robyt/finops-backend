import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { FinOpsRecommendation } from '../../../domain/models/FinOpsRecommendation.js';

const recommendationEvidenceFields = [
  'externalResourceId', 'evidenceLevel', 'evidenceStrength', 'requiresTechnicalValidation',
  'technicalEvidenceRefs', 'technicalSampleCount', 'technicalCoverageDays', 'latestTechnicalSampleAt',
  'readiness', 'normalizedActionType', 'operationalAuthorization', 'requiresManualValidation',
  'reviewScope', 'financialReviewOnly', 'technicalReviewOnly', 'blockers', 'ruleMatches',
];

const technicalRuleFields = [
  'serviceName', 'resourceType', 'readiness', 'evidenceStrength', 'recommendedActionType',
  'ruleMatches', 'blockers', 'technicalEvidenceRefs', 'metricSummary', 'ruleVersion', 'appliedThresholds',
];
const currencyCodes = Intl.supportedValuesOf('currency').join('|');
const amountPattern = String.raw`\d[\d.,]*(?:\s+\d{3})*`;
const monetaryMentionPattern = new RegExp(
  String.raw`\b(?:${currencyCodes})\s*\p{Sc}?\s*${amountPattern}|\b${amountPattern}\s*(?:${currencyCodes})\b|\p{Sc}\s*${amountPattern}|${amountPattern}\s*\p{Sc}`,
  'giu',
);

/** Project plan input to target scope, period coverage and non-financial evidence. */
export function compactExecutionPlanContext(
  snapshot: CostAnalyticsSnapshot,
  recommendation?: FinOpsRecommendation,
): Readonly<Record<string, unknown>> {
  const rawEvidence = recommendation?.evidence;
  const evidence = isRecord(rawEvidence) ? rawEvidence : {};
  const technicalRules = isRecord(evidence['deterministicRules']) ? evidence['deterministicRules'] : {};

  return {
    period: {
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
      observedThrough: snapshot.observedThrough ?? null,
      coveredDays: snapshot.coveredDays ?? null,
      isComplete: snapshot.isComplete ?? null,
    },
    ...(recommendation === undefined ? {} : { recommendation: {
      id: recommendation.id,
      cloudAccountId: recommendation.cloudAccountId,
      ...(recommendation.cloudResourceId === undefined ? {} : { cloudResourceId: recommendation.cloudResourceId }),
      ...(recommendation.resourceLinkReason === undefined ? {} : { resourceLinkReason: recommendation.resourceLinkReason }),
      type: recommendation.type,
      status: recommendation.status,
      severity: recommendation.severity,
      title: redactMonetaryMentions(recommendation.title),
      description: redactMonetaryMentions(recommendation.description),
      evidence: {
        ...pickFields(evidence, recommendationEvidenceFields),
        ...(Object.keys(technicalRules).length === 0 ? {} : {
          deterministicRules: pickFields(technicalRules, technicalRuleFields),
        }),
      },
    } }),
  };
}

/** The auditor checks plan quality; deterministic code owns the savings field. */
export function compactExecutionPlanArtifact(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { estimatedSavings: _estimatedSavings, ...plan } = value;
  return plan;
}

function pickFields(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, source[field]]));
}

function redactMonetaryMentions(value: string): string {
  return value.replace(monetaryMentionPattern, '[importe omitido]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

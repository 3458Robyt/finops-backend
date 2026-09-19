import type { CostAnalyticsSnapshot } from '../../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { AiRecommendationDraft } from '../finOpsAiTypes.js';
import type { RecommendationEvidenceSnapshot } from '../RecommendationEvidenceSnapshot.js';
import { isRecord } from '../jsonReadHelpers.js';

/** Comprueba que una recomendación técnica cite evidencia reciente y canónica. */
export function hasStrongTechnicalEvidence(
  draft: AiRecommendationDraft,
  snapshot: CostAnalyticsSnapshot,
  technicalEvidenceSnapshot?: RecommendationEvidenceSnapshot,
): boolean {
  if (!isRecord(draft.evidence)) return false;

  const evidenceRefs = readEvidenceRefs(draft.evidence);
  const sampleCount = readNumericEvidence(draft.evidence, 'technicalSampleCount');
  const coverageDays = readNumericEvidence(draft.evidence, 'technicalCoverageDays');
  const latestSampleAt = readStringEvidence(draft.evidence, 'latestTechnicalSampleAt');
  const hasResourceLink = readStringEvidence(draft.evidence, 'cloudResourceId') !== undefined &&
    readStringEvidence(draft.evidence, 'externalResourceId') !== undefined;
  const legacyStrong = evidenceRefs.length > 0 && hasResourceLink &&
    (sampleCount >= 48 || coverageDays >= 7) && isRecentTechnicalSample(latestSampleAt, snapshot);

  return technicalEvidenceSnapshot === undefined
    ? legacyStrong
    : legacyStrong && matchesCanonicalTechnicalEvidence(draft, technicalEvidenceSnapshot);
}

export function matchesCanonicalTechnicalEvidence(
  draft: AiRecommendationDraft,
  snapshot: RecommendationEvidenceSnapshot,
): boolean {
  if (!isRecord(draft.evidence)) return false;
  const evidence = draft.evidence as Record<string, unknown>;

  const externalResourceId = readStringEvidence(evidence, 'externalResourceId');
  const cloudResourceId = readStringEvidence(evidence, 'cloudResourceId');
  if (externalResourceId === undefined || cloudResourceId === undefined) return false;

  const matchingResources = snapshot.resources.filter((item) => item.externalResourceId === externalResourceId);
  const resource = matchingResources.length === 1
    ? matchingResources[0]
    : matchingResources.find((item) => item.cloudResourceId === cloudResourceId);
  if (resource === undefined || resource.linkQuality !== 'COST_AND_TECHNICAL' ||
    resource.cloudResourceId === undefined || resource.cloudResourceId !== cloudResourceId) return false;

  const refs = readEvidenceRefs(evidence);
  const metricsByRef = new Map(resource.metrics.map((metric) => [metric.evidenceRef, metric]));
  const referencedMetrics = refs.flatMap((ref) => {
    const metric = metricsByRef.get(ref);
    return metric === undefined ? [] : [metric];
  });
  const refsMatch = refs.length > 0 && refs.every((ref) => metricsByRef.has(ref));
  const ruleAllowsAction = resource.ruleEvaluation.readiness === 'GENERATABLE' &&
    resource.ruleEvaluation.blockers.length === 0;
  const numbersMatch = referencedMetrics.length > 0 && referencedMetrics.some((metric) => (
    metric.sampleCount === readNumericEvidence(evidence, 'technicalSampleCount') &&
    metric.coverageDays === readNumericEvidence(evidence, 'technicalCoverageDays') &&
    metric.latestSampledAt === readStringEvidence(evidence, 'latestTechnicalSampleAt')
  ));
  const configuredCap = readNumericEvidence(evidence, 'maxEstimatedMonthlySavings');
  const savingsWithinEvidence = draft.estimatedMonthlySavings === undefined
    ? true
    : configuredCap > 0
      ? draft.estimatedMonthlySavings <= configuredCap + 0.01
      : resource.cost === undefined || draft.estimatedMonthlySavings <= resource.cost.totalCost * resource.ruleEvaluation.maxTechnicalSavingsRate + 0.01;
  const allowedPercentages = referencedMetrics.flatMap((metric) => [
    metric.min, metric.max, metric.avg, metric.p50, metric.p95, metric.p99, metric.latest,
    metric.highUtilizationRatio * 100,
  ]);
  const narrativePercentagesMatch = extractPercentages(`${draft.title} ${draft.description}`)
    .every((claim) => allowedPercentages.some((value) => Math.abs(value - claim) <= 0.01));

  return refsMatch && ruleAllowsAction && numbersMatch && savingsWithinEvidence && narrativePercentagesMatch;
}

function readEvidenceRefs(evidence: Record<string, unknown>): readonly string[] {
  const raw = evidence['technicalEvidenceRefs'];
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

function readNumericEvidence(evidence: Record<string, unknown>, field: string): number {
  const value = evidence[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readStringEvidence(evidence: Record<string, unknown>, field: string): string | undefined {
  const value = evidence[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isRecentTechnicalSample(latestSampleAt: string | undefined, snapshot: CostAnalyticsSnapshot): boolean {
  if (latestSampleAt === undefined) return false;

  const latest = new Date(latestSampleAt).getTime();
  const periodEnd = new Date(snapshot.periodEnd).getTime();
  if (Number.isNaN(latest) || Number.isNaN(periodEnd)) return false;

  // La facturación puede terminar después del último dato técnico disponible.
  const reference = Math.min(periodEnd, Date.now());
  const ageDays = (reference - latest) / (24 * 60 * 60 * 1000);
  return ageDays >= 0 && ageDays <= 7;
}

function extractPercentages(value: string): readonly number[] {
  return [...value.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)]
    .map((match) => Number.parseFloat(match[1]!.replace(',', '.')))
    .filter((number) => Number.isFinite(number));
}

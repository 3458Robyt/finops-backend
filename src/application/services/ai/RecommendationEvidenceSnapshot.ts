import { createHash } from 'node:crypto';

import type { TechnicalResourceRuleEvaluation } from './TechnicalOptimizationRuleEngine.js';

export const recommendationEvidenceSnapshotVersion = '1';

export type RecommendationEvidenceAvailability =
  | 'NO_TECHNICAL_EVIDENCE'
  | 'COST_USAGE_AND_TECHNICAL_AVAILABLE';

export interface RecommendationEvidenceMetric {
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly providerNamespace?: string;
  readonly regionId?: string;
  readonly compartmentId?: string;
  readonly dimensionsHash?: string;
  readonly statistic?: string;
  readonly granularitySeconds?: number;
  readonly sampleCount: number;
  readonly coverageDays: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly latest: number;
  readonly highUtilizationSampleCount: number;
  readonly highUtilizationRatio: number;
  readonly firstSampledAt: string;
  readonly latestSampledAt: string;
  readonly evidenceRef: string;
}

export interface RecommendationEvidenceResource {
  readonly externalResourceId: string;
  readonly cloudResourceId?: string;
  readonly cloudConnectionId?: string;
  readonly resourceName?: string;
  readonly provider: string;
  readonly resourceType?: string;
  readonly serviceName?: string;
  readonly linkQuality: 'COST_AND_TECHNICAL' | 'TECHNICAL_ONLY';
  readonly cost?: {
    readonly cloudResourceId?: string;
    readonly totalCost: number;
    readonly currency: string;
    readonly focusMetricCount: number;
  };
  readonly usage: readonly {
    readonly serviceName: string;
    readonly consumedQuantity: number;
    readonly consumedUnit: string;
    readonly totalCost: number;
    readonly currency: string;
  }[];
  readonly metrics: readonly RecommendationEvidenceMetric[];
  readonly ruleEvaluation: TechnicalResourceRuleEvaluation;
}

export interface RecommendationEvidenceSnapshot {
  readonly version: typeof recommendationEvidenceSnapshotVersion;
  readonly hash: string;
  readonly tenantId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly generatedAt: string;
  readonly availability: RecommendationEvidenceAvailability;
  /** Fail closed when the bounded raw query cannot include every stream. */
  readonly summaryTruncated?: boolean;
  readonly resources: readonly RecommendationEvidenceResource[];
  readonly deterministicRules: readonly TechnicalResourceRuleEvaluation[];
  readonly sourceDiagnostics?: readonly {
    readonly externalResourceId: string;
    readonly cloudConnectionId: string;
    readonly metricName: 'CpuUtilization' | 'MemoryUtilization';
    readonly catalogStatus: 'NOT_DISCOVERED' | 'DISABLED' | 'ENABLED';
    readonly lastDiscoveredAt?: string;
    readonly latestJobStatus?: string;
  }[];
}

export function hashRecommendationEvidenceSnapshot(
  snapshot: Omit<RecommendationEvidenceSnapshot, 'hash'>,
): string {
  const { generatedAt: _generatedAt, ...stableFacts } = snapshot;
  return createHash('sha256').update(JSON.stringify(stableFacts)).digest('hex');
}

export function formatRecommendationEvidenceSnapshot(
  snapshot: RecommendationEvidenceSnapshot,
  candidateResources?: readonly Readonly<{ readonly resourceId?: string; readonly cloudResourceId?: string }>[],
): string {
  return [
    'Evidencia tecnica canonica:',
    JSON.stringify({
      snapshot: compactRecommendationEvidenceSnapshot(snapshot, candidateResources),
      rules: [
        'Solo usa COST_USAGE_AND_TECHNICAL cuando la recomendacion cite referencias existentes del snapshot.',
        'Si linkQuality no es COST_AND_TECHNICAL o las reglas tienen blockers, exige requiresTechnicalValidation=true.',
        'No inventes recursos, metricas, valores ni ahorro fuera del snapshot.',
      ],
    }),
  ].join('\n');
}

/**
 * Proyección para el prompt: conserva hechos necesarios y elimina la copia
 * redundante de `metricSummary` y reglas de recursos que no entran en el lote
 * de candidatos. El snapshot completo sigue siendo el que se persiste y se
 * usa en las compuertas determinísticas.
 */
export function compactRecommendationEvidenceSnapshot(
  snapshot: RecommendationEvidenceSnapshot,
  candidateResources?: readonly Readonly<{ readonly resourceId?: string; readonly cloudResourceId?: string }>[],
): Readonly<Record<string, unknown>> {
  const { sourceDiagnostics: _sourceDiagnostics, ...promptSnapshot } = snapshot;
  const resources = snapshot.resources
    .filter((resource) => candidateResources === undefined || candidateResources.some((candidate) => (
      candidate.resourceId === resource.externalResourceId
      && (candidate.cloudResourceId === undefined || candidate.cloudResourceId === resource.cloudResourceId)
    )))
    .map((resource) => ({
    ...resource,
    ruleEvaluation: compactRuleEvaluation(resource.ruleEvaluation),
    }));

  return {
    ...promptSnapshot,
    resources,
    deterministicRules: resources.map((resource) => resource.ruleEvaluation),
  };
}

function compactRuleEvaluation(
  evaluation: RecommendationEvidenceSnapshot['resources'][number]['ruleEvaluation'],
): Readonly<Record<string, unknown>> {
  const { metricSummary: _metricSummary, ...compact } = evaluation;
  return compact;
}

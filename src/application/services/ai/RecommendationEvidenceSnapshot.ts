import { createHash } from 'node:crypto';

import type { TechnicalResourceRuleEvaluation } from './TechnicalOptimizationRuleEngine.js';

export const recommendationEvidenceSnapshotVersion = '1';

export type RecommendationEvidenceAvailability =
  | 'NO_TECHNICAL_EVIDENCE'
  | 'COST_USAGE_AND_TECHNICAL_AVAILABLE';

export interface RecommendationEvidenceMetric {
  readonly metricName: string;
  readonly metricUnit?: string;
  readonly sampleCount: number;
  readonly coverageDays: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly latest: number;
  readonly firstSampledAt: string;
  readonly latestSampledAt: string;
  readonly evidenceRef: string;
}

export interface RecommendationEvidenceResource {
  readonly externalResourceId: string;
  readonly cloudResourceId?: string;
  readonly provider: string;
  readonly resourceType?: string;
  readonly serviceName?: string;
  readonly linkQuality: 'COST_AND_TECHNICAL' | 'TECHNICAL_ONLY';
  readonly cost?: {
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
  readonly resources: readonly RecommendationEvidenceResource[];
  readonly deterministicRules: readonly TechnicalResourceRuleEvaluation[];
}

export function hashRecommendationEvidenceSnapshot(
  snapshot: Omit<RecommendationEvidenceSnapshot, 'hash'>,
): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function formatRecommendationEvidenceSnapshot(snapshot: RecommendationEvidenceSnapshot): string {
  return [
    'Evidencia tecnica canonica:',
    JSON.stringify({
      snapshot,
      rules: [
        'Solo usa COST_USAGE_AND_TECHNICAL cuando la recomendacion cite referencias existentes del snapshot.',
        'Si linkQuality no es COST_AND_TECHNICAL o las reglas tienen blockers, exige requiresTechnicalValidation=true.',
        'No inventes recursos, metricas, valores ni ahorro fuera del snapshot.',
      ],
    }),
  ].join('\n');
}

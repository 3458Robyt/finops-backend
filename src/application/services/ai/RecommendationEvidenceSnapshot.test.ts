import { describe, expect, it } from 'vitest';
import type { RecommendationEvidenceSnapshot } from './RecommendationEvidenceSnapshot.js';

import {
  compactRecommendationEvidenceSnapshot,
  hashRecommendationEvidenceSnapshot,
  recommendationEvidenceSnapshotVersion,
} from './RecommendationEvidenceSnapshot.js';

describe('hashRecommendationEvidenceSnapshot', () => {
  it('ignores the volatile generation timestamp', () => {
    const base = {
      version: recommendationEvidenceSnapshotVersion,
      tenantId: 'tenant-1',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      availability: 'NO_TECHNICAL_EVIDENCE' as const,
      resources: [],
      deterministicRules: [],
    };

    expect(hashRecommendationEvidenceSnapshot({
      ...base,
      generatedAt: '2026-07-23T10:00:00.000Z',
    })).toBe(hashRecommendationEvidenceSnapshot({
      ...base,
      generatedAt: '2026-07-23T11:00:00.000Z',
    }));
  });

  it('compacts duplicated rule summaries for model prompts', () => {
    const snapshot: RecommendationEvidenceSnapshot = {
      version: recommendationEvidenceSnapshotVersion,
      tenantId: 'tenant-1',
      periodStart: '2026-06-01T00:00:00.000Z',
      periodEnd: '2026-07-01T00:00:00.000Z',
      generatedAt: '2026-07-23T10:00:00.000Z',
      availability: 'COST_USAGE_AND_TECHNICAL_AVAILABLE' as const,
      resources: [{
        externalResourceId: 'resource-1',
        provider: 'OCI',
        linkQuality: 'COST_AND_TECHNICAL' as const,
        usage: [],
        metrics: [],
        ruleEvaluation: {
          externalResourceId: 'resource-1',
          provider: 'OCI',
          readiness: 'GENERATABLE' as const,
          evidenceStrength: 'HIGH' as const,
          recommendedActionType: 'RIGHTSIZING' as const,
          ruleMatches: [],
          blockers: [],
          sourceFacts: [],
          technicalEvidenceRefs: [],
          metricSummary: [{ metricName: 'CPU', sampleCount: 1 }],
          maxTechnicalSavingsRate: 0.25,
        },
      }],
      deterministicRules: [],
    };

    const compact = compactRecommendationEvidenceSnapshot(snapshot);
    expect(compact.resources).toEqual([
      expect.objectContaining({
        ruleEvaluation: expect.not.objectContaining({ metricSummary: expect.anything() }),
      }),
    ]);
    expect(compact.deterministicRules).toHaveLength(1);

    expect(compactRecommendationEvidenceSnapshot(snapshot, [])).toMatchObject({
      resources: [],
      deterministicRules: [],
    });
  });
});

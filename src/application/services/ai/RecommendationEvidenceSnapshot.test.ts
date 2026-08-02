import { describe, expect, it } from 'vitest';

import {
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
});

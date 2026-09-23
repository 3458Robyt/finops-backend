import { describe, expect, test, vi } from 'vitest';
import type { IRecommendationRepository } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { RecommendationReadinessReport } from './RecommendationReadinessGate.js';
import type { PreparedRecommendationAnalysis } from './finOpsAiTypes.js';
import { FinOpsAiRecommendationRunner } from './FinOpsAiRecommendationRunner.js';

const snapshot: CostAnalyticsSnapshot = {
  tenantId: 'tenant-1',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  totalCost: 0,
  currency: 'COP',
  metricCount: 0,
  providers: [],
  accounts: [],
  services: [],
  environments: [],
  topResources: [],
};

describe('FinOpsAiRecommendationRunner no-op readiness', () => {
  test('does not claim persistence or invoke the LLM when no candidate is eligible', async () => {
    const readinessReport: RecommendationReadinessReport = {
      candidates: [],
      blocked: [],
      deferred: [],
      summary: 'No hay oportunidades con evidencia determinística suficiente.',
    };
    const prepared: PreparedRecommendationAnalysis = {
      snapshot,
      readinessReport,
      evidenceHash: 'hash',
      deterministicAnalysis: { trends: [], summary: 'none' } as never,
      model: 'model',
      auditorModel: 'auditor',
    };
    const recommendationRepository = { createMany: vi.fn() } as unknown as IRecommendationRepository;
    const contextAssembler = { assembleRecommendationContext: vi.fn() } as never;
    const artifactGenerator = { generateAuditedDrafts: vi.fn() } as never;
    const traceRecorder = { record: vi.fn() } as never;
    const preparer = { prepare: vi.fn() } as never;
    const runner = new FinOpsAiRecommendationRunner(
      recommendationRepository,
      contextAssembler,
      artifactGenerator,
      traceRecorder,
      preparer,
      'model',
      'auditor',
    );

    const result = await runner.run({ tenantId: 'tenant-1', persist: true, prepared });

    expect(result.recommendations).toEqual([]);
    expect(result.persisted).toBe(false);
    expect(result.analysis.generatedCount).toBe(0);
    expect(recommendationRepository.createMany).not.toHaveBeenCalled();
    expect(artifactGenerator.generateAuditedDrafts).not.toHaveBeenCalled();
  });
});

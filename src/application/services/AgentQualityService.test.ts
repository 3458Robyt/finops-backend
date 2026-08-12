import { describe, expect, it } from 'vitest';
import type {
  AgentQualityRecommendationRow,
  AgentQualityReportQuery,
  AgentQualityTraceRow,
  IAgentQualityRepository,
} from '../../domain/interfaces/IAgentQualityRepository.js';
import { AgentQualityService } from './AgentQualityService.js';

class FakeQualityRepository implements IAgentQualityRepository {
  constructor(
    private readonly recommendations: readonly AgentQualityRecommendationRow[],
    private readonly traces: readonly AgentQualityTraceRow[] = [],
  ) {}

  public query: AgentQualityReportQuery | null = null;

  public async listRecommendationRows(query: AgentQualityReportQuery): Promise<readonly AgentQualityRecommendationRow[]> {
    this.query = query;
    return this.recommendations;
  }

  public async listTraceRows(query: AgentQualityReportQuery): Promise<readonly AgentQualityTraceRow[]> {
    this.query = query;
    return this.traces;
  }
}

describe('AgentQualityService', () => {
  it('builds honest totals and dimensions from decisions, evidence and verified savings', async () => {
    const repository = new FakeQualityRepository([
      {
        id: 'rec-1',
        type: 'RIGHTSIZING',
        provider: 'OCI',
        estimatedMonthlySavings: 100,
        decision: 'APPROVED',
        observedSavings: 80,
        evidence: {
          ruleMatches: ['CPU_IDLE_CANDIDATE'],
          evidenceStrength: 'HIGH',
        },
      },
      {
        id: 'rec-2',
        type: 'PERFORMANCE_CAPACITY_REVIEW',
        provider: 'OCI',
        estimatedMonthlySavings: null,
        decision: 'REJECTED',
        evidence: {
          requiresTechnicalValidation: true,
          evidenceStrength: 'LOW',
          deterministicRules: { blockers: ['INSUFFICIENT_TECHNICAL_COVERAGE'], ruleMatches: ['CPU_HIGH_UTILIZATION'] },
        },
      },
      {
        id: 'rec-3',
        type: 'STORAGE_REVIEW',
        provider: null,
        evidence: { recommendationEvidenceSnapshot: { resources: [{ ruleEvaluation: { ruleMatches: ['DISK_LOW_UTILIZATION'] } }] } },
      },
    ], [
      { operation: 'RECOMMENDATION', status: 'SUCCESS', latencyMs: 100, promptTokenEstimate: 100, responseTokenEstimate: 50 },
      { operation: 'AUDIT', status: 'ERROR', latencyMs: 300, promptTokenEstimate: 200, responseTokenEstimate: 20 },
    ]);
    const service = new AgentQualityService(repository, {
      inputCostPerMillionTokensUsd: 1,
      outputCostPerMillionTokensUsd: 2,
    });

    const report = await service.getReport('tenant-1', 30, new Date('2026-08-12T00:00:00.000Z'));

    expect(report.totals).toMatchObject({
      generated: 3,
      reviewed: 2,
      approved: 1,
      rejected: 1,
      reviewRate: 66.67,
      approvalRate: 50,
      abstained: 1,
      insufficientEvidence: 1,
      verified: 1,
      estimatedSavings: 100,
      verifiedSavings: 80,
      estimatedVsVerifiedErrorPercent: 20,
      verifiedOutcomeRate: 100,
    });
    expect(report.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'RULE', key: 'CPU_IDLE_CANDIDATE', generated: 1 }),
      expect.objectContaining({ dimension: 'RULE', key: 'CPU_HIGH_UTILIZATION', generated: 1 }),
      expect.objectContaining({ dimension: 'RULE', key: 'DISK_LOW_UTILIZATION', generated: 1 }),
      expect.objectContaining({ dimension: 'PROVIDER', key: 'PROVEEDOR_NO_IDENTIFICADO', generated: 1 }),
    ]));
    expect(report.traces).toMatchObject({
      calls: 2,
      successfulCalls: 1,
      failedCalls: 1,
      successRate: 50,
      averageLatencyMs: 200,
      p95LatencyMs: 300,
      totalTokens: 370,
      estimatedCostUsd: 0.00044,
      costEstimateAvailable: true,
    });
    expect(report.notes[0]).toContain('proxy');
    expect(repository.query?.tenantId).toBe('tenant-1');
  });

  it('does not fabricate rates or token cost when there is no evidence', async () => {
    const service = new AgentQualityService(new FakeQualityRepository([]));
    const report = await service.getReport('tenant-1', 90, new Date('2026-08-12T00:00:00.000Z'));

    expect(report.totals.reviewRate).toBeNull();
    expect(report.totals.estimatedVsVerifiedErrorPercent).toBeNull();
    expect(report.traces.successRate).toBeNull();
    expect(report.traces.estimatedCostUsd).toBeNull();
    expect(report.traces.costEstimateAvailable).toBe(false);
  });
});

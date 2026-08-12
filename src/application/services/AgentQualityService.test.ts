import { describe, expect, it } from 'vitest';
import type {
  AgentQualityPage,
  AgentQualityPageQuery,
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
    private readonly pageSize = 1_000,
  ) {}

  public query: AgentQualityReportQuery | null = null;
  public recommendationPageCalls = 0;
  public tracePageCalls = 0;

  public async listRecommendationRows(
    query: AgentQualityReportQuery,
    page: AgentQualityPageQuery,
  ): Promise<AgentQualityPage<AgentQualityRecommendationRow>> {
    this.query = query;
    this.recommendationPageCalls += 1;
    return paginate(this.recommendations, page, this.pageSize);
  }

  public async listTraceRows(
    query: AgentQualityReportQuery,
    page: AgentQualityPageQuery,
  ): Promise<AgentQualityPage<AgentQualityTraceRow>> {
    this.query = query;
    this.tracePageCalls += 1;
    return paginate(this.traces, page, this.pageSize);
  }
}

function paginate<T extends { readonly id: string; readonly createdAt: Date }>(
  rows: readonly T[],
  page: AgentQualityPageQuery,
  pageSize: number,
): AgentQualityPage<T> {
  const start = page.cursor === undefined
    ? 0
    : rows.findIndex((row) => row.id === page.cursor?.id) + 1;
  const size = Math.min(page.limit, pageSize);
  const visible = rows.slice(start, start + size);
  const hasMore = start + size < rows.length;
  return {
    rows: visible,
    ...(hasMore && visible.length > 0
      ? { nextCursor: { createdAt: visible[visible.length - 1]!.createdAt, id: visible[visible.length - 1]!.id } }
      : {}),
  };
}

describe('AgentQualityService', () => {
  it('builds honest totals and dimensions from decisions, evidence and verified savings', async () => {
    const repository = new FakeQualityRepository([
      {
        id: 'rec-1',
        createdAt: new Date('2026-08-11T00:00:00.000Z'),
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
        createdAt: new Date('2026-08-10T00:00:00.000Z'),
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
        createdAt: new Date('2026-08-09T00:00:00.000Z'),
        type: 'STORAGE_REVIEW',
        provider: null,
        evidence: { recommendationEvidenceSnapshot: { resources: [{ ruleEvaluation: { ruleMatches: ['DISK_LOW_UTILIZATION'] } }] } },
      },
    ], [
      { id: 'trace-1', createdAt: new Date('2026-08-11T00:00:00.000Z'), operation: 'RECOMMENDATION', status: 'SUCCESS', latencyMs: 100, promptTokenEstimate: 100, responseTokenEstimate: 50 },
      { id: 'trace-2', createdAt: new Date('2026-08-10T00:00:00.000Z'), operation: 'AUDIT', status: 'ERROR', latencyMs: 300, promptTokenEstimate: 200, responseTokenEstimate: 20 },
    ], 2);
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
    expect(repository.recommendationPageCalls).toBe(2);
    expect(repository.tracePageCalls).toBe(1);
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

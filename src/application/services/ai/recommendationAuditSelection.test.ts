import { describe, expect, it } from 'vitest';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { AiRecommendationDraft } from './finOpsAiTypes.js';
import { selectAuditedRecommendationDrafts } from './recommendationAuditSelection.js';

const snapshot: CostAnalyticsSnapshot = {
  tenantId: 'tenant-1',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-29',
  totalCost: 1_000,
  currency: 'USD',
  metricCount: 100,
  providers: [{ provider: 'OCI', totalCost: 1_000, metricCount: 100 }],
  accounts: [{ cloudAccountId: 'account-1', provider: 'OCI', name: 'Cuenta', totalCost: 1_000, metricCount: 100 }],
  services: [],
  environments: [],
  topResources: [],
};

function draft(candidateId: string, estimatedMonthlySavings: number): AiRecommendationDraft {
  return {
    cloudAccountId: 'account-1',
    type: 'SERVICE_COST_REVIEW',
    severity: 'MEDIUM',
    title: 'Revisar costos de la cuenta',
    description: 'Revisar el costo y el consumo facturado antes de actuar.',
    evidence: { candidateId, evidenceLevel: 'COST_AND_USAGE' },
    estimatedMonthlySavings,
    currency: 'USD',
  };
}

describe('selectAuditedRecommendationDrafts', () => {
  it('keeps a valid candidate when another candidate fails deterministic quality', () => {
    const drafts = [draft('service-1', 80), draft('service-2', 2_000)];
    const result = selectAuditedRecommendationDrafts({
      drafts,
      snapshot,
      auditReport: {
        verdict: 'APPROVED',
        score: 95,
        checks: [],
        blockingIssues: [],
        requiredChanges: [],
        candidateAudits: [
          { index: 0, candidateId: 'service-1', verdict: 'APPROVED', score: 95, checks: [], blockingIssues: [], requiredChanges: [] },
          { index: 1, candidateId: 'service-2', verdict: 'APPROVED', score: 95, checks: [], blockingIssues: [], requiredChanges: [] },
        ],
      },
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.candidateAudits[1]?.verdict).toBe('REJECTED');
    expect(result.candidateAudits[1]?.blockingIssues.join(' ')).toContain('ahorros');
  });

  it('rejects the whole legacy batch when the global auditor rejects it', () => {
    const result = selectAuditedRecommendationDrafts({
      drafts: [draft('service-1', 80)],
      snapshot,
      auditReport: { verdict: 'REJECTED', score: 30, checks: [], blockingIssues: ['Falta evidencia'], requiredChanges: [] },
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it('keeps legacy global-audit compatibility but requires IDs for candidate audits', () => {
    const legacyDraft = {
      ...draft('service-1', 80),
      evidence: { evidenceLevel: 'COST_AND_USAGE' as const },
    };
    const globalResult = selectAuditedRecommendationDrafts({
      drafts: [legacyDraft],
      snapshot,
      auditReport: { verdict: 'APPROVED', score: 95, checks: [], blockingIssues: [], requiredChanges: [] },
    });
    expect(globalResult.accepted).toHaveLength(1);

    const candidateResult = selectAuditedRecommendationDrafts({
      drafts: [legacyDraft],
      snapshot,
      auditReport: {
        verdict: 'APPROVED',
        score: 95,
        checks: [],
        blockingIssues: [],
        requiredChanges: [],
        candidateAudits: [{ index: 0, candidateId: 'draft-0', verdict: 'APPROVED', score: 95, checks: [], blockingIssues: [], requiredChanges: [] }],
      },
    });
    expect(candidateResult.accepted).toHaveLength(0);
    expect(candidateResult.candidateAudits[0]?.blockingIssues.join(' ')).toContain('candidato autorizado');
  });
});

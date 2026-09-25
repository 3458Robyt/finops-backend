import { describe, expect, test, vi } from 'vitest';
import type { IRecommendationRepository } from '../../../domain/interfaces/IRecommendationRepository.js';
import type { CostAnalyticsSnapshot } from '../../../domain/interfaces/ICostAnalyticsRepository.js';
import type { RecommendationReadinessReport } from './RecommendationReadinessGate.js';
import type { PreparedRecommendationAnalysis } from './finOpsAiTypes.js';
import { FinOpsAiRecommendationRunner } from './FinOpsAiRecommendationRunner.js';
import { AiAuditRejectedError } from '../../../domain/errors/errors.js';

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

  test('treats a valid model abstention as a successful non-persisted result', async () => {
    const readinessReport: RecommendationReadinessReport = {
      candidates: [{ readiness: 'GENERATABLE' } as never],
      blocked: [],
      deferred: [],
      summary: 'Hay candidatos, pero el modelo no encontró una recomendación segura.',
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
    const contextAssembler = {
      assembleRecommendationContext: vi.fn().mockResolvedValue({ systemPrompt: 'prompt' }),
    } as never;
    const artifactGenerator = {
      generateAuditedDrafts: vi.fn().mockResolvedValue({
        drafts: [],
        approvedDrafts: [],
        rejectedDrafts: [],
        candidateAudits: [],
        firstRawResponse: '{"recommendations":[]}',
      }),
    } as never;
    const traceRecorder = { record: vi.fn().mockResolvedValue(undefined) } as never;
    const runner = new FinOpsAiRecommendationRunner(
      recommendationRepository,
      contextAssembler,
      artifactGenerator,
      traceRecorder,
      { prepare: vi.fn() } as never,
      'model',
      'auditor',
    );
    const onStage = vi.fn();

    const result = await runner.run({ tenantId: 'tenant-1', persist: true, prepared, onStage });

    expect(result.recommendations).toEqual([]);
    expect(result.persisted).toBe(false);
    expect(result.analysis.generatedCount).toBe(0);
    expect(result.analysis.auditReport).toBeUndefined();
    expect(recommendationRepository.createMany).not.toHaveBeenCalled();
    expect(traceRecorder.record).toHaveBeenCalledWith(expect.objectContaining({
      responseText: '{"recommendations":[]}',
    }));
    expect(onStage).toHaveBeenCalledWith('PERSISTENCE');
  });

  test('uses an opaque diagnostic id when the auditor rejects a recommendation', async () => {
    const prepared: PreparedRecommendationAnalysis = {
      snapshot,
      readinessReport: { candidates: [{ readiness: 'GENERATABLE' } as never], blocked: [], deferred: [], summary: 'candidate' },
      evidenceHash: 'hash',
      deterministicAnalysis: { trends: [], summary: 'none' } as never,
      model: 'model',
      auditorModel: 'auditor',
    };
    const runner = new FinOpsAiRecommendationRunner(
      { createMany: vi.fn() } as unknown as IRecommendationRepository,
      { assembleRecommendationContext: vi.fn().mockResolvedValue({ systemPrompt: 'prompt' }) } as never,
      {
        generateAuditedDrafts: vi.fn().mockResolvedValue({
          drafts: [{}], approvedDrafts: [], rejectedDrafts: [{}], candidateAudits: [],
          auditReport: { verdict: 'REJECTED', score: 10 }, firstRawResponse: '{}',
        }),
      } as never,
      { record: vi.fn().mockResolvedValue(undefined) } as never,
      { prepare: vi.fn() } as never,
      'model',
      'auditor',
    );

    const rejection = await runner.run({ tenantId: 'tenant-private-id', persist: false, prepared }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AiAuditRejectedError);
    expect((rejection as AiAuditRejectedError).diagnosticId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
    expect((rejection as AiAuditRejectedError).diagnosticId).not.toContain('tenant-private-id');
  });

  test('attaches server cost scope only for persistence, never to preview output', async () => {
    const costEvidenceScope = {
      provider: 'AWS' as const,
      cloudAccountId: 'aws-prod',
      cloudResourceId: 'cloud-resource-1',
      resourceId: 'i-prod-1',
      serviceName: 'Amazon EC2',
      expectedMetricCount: 80,
      periodStart: snapshot.periodStart,
      periodEnd: snapshot.periodEnd,
    };
    const draft = {
      cloudAccountId: 'aws-prod',
      cloudResourceId: 'cloud-resource-1',
      type: 'RIGHTSIZING',
      severity: 'MEDIUM' as const,
      title: 'Revisar capacidad de instancia',
      description: 'Validar una alternativa de menor capacidad.',
      evidence: { candidateId: 'resource-1' },
      estimatedMonthlySavings: 25,
      currency: 'USD',
    };
    const prepared: PreparedRecommendationAnalysis = {
      snapshot,
      readinessReport: {
        candidates: [{ id: 'resource-1', costEvidenceScope } as never],
        blocked: [],
        deferred: [],
        summary: 'candidate',
      },
      evidenceHash: 'hash',
      deterministicAnalysis: { trends: [], summary: 'none' } as never,
      model: 'model',
      auditorModel: 'auditor',
    };
    const recommendationRepository = { createMany: vi.fn().mockResolvedValue([]) } as unknown as IRecommendationRepository;
    const runner = new FinOpsAiRecommendationRunner(
      recommendationRepository,
      {
        assembleRecommendationContext: vi.fn().mockResolvedValue({
          systemPrompt: 'prompt',
          learningContext: { memoryIds: [], caseIds: [], summary: '' },
        }),
      } as never,
      {
        generateAuditedDrafts: vi.fn().mockResolvedValue({
          drafts: [draft],
          approvedDrafts: [draft],
          rejectedDrafts: [],
          candidateAudits: [{
            audit: { candidateId: 'resource-1', verdict: 'APPROVED', score: 95, checks: [], blockingIssues: [], requiredChanges: [] },
          }],
          auditReport: { verdict: 'APPROVED', score: 95, checks: [], blockingIssues: [], requiredChanges: [] },
          firstRawResponse: '{}',
        }),
      } as never,
      { record: vi.fn().mockResolvedValue(undefined) } as never,
      { prepare: vi.fn() } as never,
      'model',
      'auditor',
    );

    await runner.run({ tenantId: 'tenant-1', persist: true, prepared });
    expect(recommendationRepository.createMany).toHaveBeenLastCalledWith([
      expect.objectContaining({ costEvidenceScope }),
    ]);

    const preview = await runner.run({ tenantId: 'tenant-1', persist: false, prepared });
    expect(recommendationRepository.createMany).toHaveBeenCalledTimes(1);
    expect(preview.recommendations[0]).not.toHaveProperty('costEvidenceScope');
  });
});

import { describe, expect, test, vi } from 'vitest';
import type { IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import { FinOpsArtifactAiRunner } from './finOpsArtifactAiRunner.js';

describe('FinOpsArtifactAiRunner', () => {
  test('keeps recommendation generation bounded to two prioritized outputs', async () => {
    const aiGateway = { generateText: vi.fn().mockResolvedValue('{"recommendations":[]}') } as unknown as IAiGateway;
    const runner = new FinOpsArtifactAiRunner(aiGateway, { record: vi.fn() }, 'generator-model', 'auditor-model');

    await runner.generateRecommendations('system prompt');

    expect(aiGateway.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: 'generator-model',
      maxTokens: 750,
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('hasta 2 recomendaciones') }),
      ]),
    }));
  });

  test('audits execution plans without financial aggregates or server-owned savings', async () => {
    const aiGateway = {
      generateText: vi.fn().mockResolvedValue(JSON.stringify({
        verdict: 'APPROVED', score: 90, checks: [], blockingIssues: [], requiredChanges: [],
      })),
    } as unknown as IAiGateway;
    const runner = new FinOpsArtifactAiRunner(aiGateway, { record: vi.fn() }, 'generator', 'auditor');
    const snapshot = {
      tenantId: 'tenant-1', periodStart: '2026-09-01', periodEnd: '2026-10-01',
      totalCost: 169, currency: 'USD', metricCount: 1,
      providers: [], accounts: [{ cloudAccountId: 'account-1', provider: 'OCI', name: 'Account', totalCost: 169, metricCount: 1 }],
      services: [], environments: [], topResources: [],
    } as never;
    const recommendation = {
      id: 'rec-1', cloudAccountId: 'account-1', cloudResourceId: 'resource-1',
      type: 'RIGHTSIZING', status: 'PENDING', severity: 'MEDIUM',
      title: 'Validar capacidad USD 157.50', description: 'Costo actual USD 169.', currency: 'USD',
      estimatedMonthlySavings: 157.5,
      evidence: { observedCost: 169, savingsCalculation: { amount: 157.5, currency: 'USD' }, technicalEvidenceRefs: ['metric-ref'] },
    } as never;

    await runner.auditArtifact({
      artifactType: 'execution_plan', snapshot, recommendation,
      artifact: { summary: 'Validar capacidad.', estimatedSavings: { amount: 157.5, currency: 'USD' } },
    });

    const request = vi.mocked(aiGateway.generateText).mock.calls[0]?.[0];
    const userPrompt = request?.messages[1]?.content ?? '';
    expect(userPrompt).not.toContain('169');
    expect(userPrompt).not.toContain('157.5');
    expect(userPrompt).not.toContain('estimatedSavings');
    expect(userPrompt).toContain('metric-ref');
    expect(userPrompt).toContain('account-1');
  });

  test('does not resend server-owned savings when repairing a plan', async () => {
    const aiGateway = { generateText: vi.fn().mockResolvedValue('{}') } as unknown as IAiGateway;
    const runner = new FinOpsArtifactAiRunner(aiGateway, { record: vi.fn() }, 'generator', 'auditor');

    await runner.reviseExecutionPlan('system', ['Corrige el resumen.'], {
      summary: 'Validar capacidad.',
      estimatedSavings: { amount: 157.5, currency: 'USD' },
    });

    const request = vi.mocked(aiGateway.generateText).mock.calls[0]?.[0];
    const userPrompt = request?.messages[1]?.content ?? '';
    expect(userPrompt).not.toContain('157.5');
    expect(userPrompt).toContain('Validar capacidad.');
  });

  test('passes the configured low reasoning effort to the auditor', async () => {
    const aiGateway = {
      generateText: vi.fn().mockResolvedValue(JSON.stringify({
        verdict: 'APPROVED',
        score: 90,
        checks: [],
        blockingIssues: [],
        requiredChanges: [],
      })),
    } as unknown as IAiGateway;
    const traceRecorder = { record: vi.fn().mockResolvedValue(undefined) };
    const runner = new FinOpsArtifactAiRunner(
      aiGateway,
      traceRecorder,
      'generator-model',
      'auditor-model',
      { timeoutMs: 90_000, maxRetries: 0, reasoningEffort: 'low' },
    );

    await runner.auditArtifact({
      artifactType: 'recommendations',
      snapshot: {
        tenantId: 'tenant-1',
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        periodEnd: new Date('2026-10-01T00:00:00.000Z'),
        totalCost: 0,
        currency: 'COP',
        metricCount: 0,
        providers: [],
        accounts: [],
        services: [],
        environments: [],
        topResources: [],
        topUsage: [],
        usageInsights: [],
        anomalies: [],
        forecasts: [],
      } as never,
      artifact: { recommendations: [] },
    });

    expect(aiGateway.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: 'auditor-model',
      reasoningEffort: 'low',
      timeoutMs: 50_000,
    }));
  });
});

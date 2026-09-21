import { describe, expect, test, vi } from 'vitest';
import type { IAiGateway } from '../../../domain/interfaces/IAiGateway.js';
import { FinOpsArtifactAiRunner } from './finOpsArtifactAiRunner.js';

describe('FinOpsArtifactAiRunner', () => {
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

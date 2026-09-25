import { describe, expect, test, vi } from 'vitest';
import { AiAuditRejectedError, ProviderTimeoutError } from '../../../domain/errors/errors.js';
import { FinOpsAiExecutionPlanRunner } from './FinOpsAiExecutionPlanRunner.js';

describe('FinOpsAiExecutionPlanRunner', () => {
  test('keeps an approved persisted plan when trace persistence fails', async () => {
    const recommendation = { id: 'rec-1', title: 'review', description: 'test' } as never;
    const plan = { id: 'plan-1' } as never;
    const createExecutionPlan = vi.fn().mockResolvedValue(plan);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const runner = new FinOpsAiExecutionPlanRunner(
      { getLatestTenantSnapshot: vi.fn().mockResolvedValue({ tenantId: 'tenant-1' }) } as never,
      { findById: vi.fn().mockResolvedValue(recommendation), createExecutionPlan } as never,
      { assembleExecutionPlanContext: vi.fn().mockResolvedValue({ systemPrompt: 'prompt' }) } as never,
      { generateAuditedPlan: vi.fn().mockResolvedValue({
        content: { summary: 'draft' },
        auditReport: { verdict: 'APPROVED', score: 90, checks: [], blockingIssues: [], requiredChanges: [] },
        firstRawResponse: '{}',
      }) } as never,
      { record: vi.fn().mockRejectedValue(new Error('trace sink unavailable')) } as never,
      'generator-model',
      'auditor-model',
    );

    try {
      await expect(runner.run({ tenantId: 'tenant-1', userId: 'user-1', recommendationId: 'rec-1' }))
        .resolves.toBe(plan);
      expect(createExecutionPlan).toHaveBeenCalledOnce();
    } finally {
      dateNow.mockRestore();
    }
  });

  test('starts the deadline before data preparation and never persists after generation timeout', async () => {
    const recommendation = { id: 'rec-1', title: 'review', description: 'test' } as never;
    const snapshot = { tenantId: 'tenant-1' } as never;
    const findById = vi.fn().mockResolvedValue(recommendation);
    const createExecutionPlan = vi.fn();
    const generateAuditedPlan = vi.fn().mockRejectedValue(new ProviderTimeoutError());
    const recordTrace = vi.fn().mockRejectedValue(new Error('trace sink unavailable'));
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const runner = new FinOpsAiExecutionPlanRunner(
      { getLatestTenantSnapshot: vi.fn().mockResolvedValue(snapshot) } as never,
      { findById, createExecutionPlan } as never,
      { assembleExecutionPlanContext: vi.fn().mockResolvedValue({ systemPrompt: 'prompt' }) } as never,
      { generateAuditedPlan } as never,
      { record: recordTrace } as never,
      'generator-model',
      'auditor-model',
    );

    try {
      await expect(runner.run({ tenantId: 'tenant-1', userId: 'user-1', recommendationId: 'rec-1' }))
        .rejects.toBeInstanceOf(ProviderTimeoutError);
      expect(generateAuditedPlan).toHaveBeenCalledWith(
        'tenant-1',
        'user-1',
        snapshot,
        recommendation,
        'prompt',
        121_000,
      );
      expect(createExecutionPlan).not.toHaveBeenCalled();
      expect(recordTrace).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: 'tenant-1',
        userId: 'user-1',
        operation: 'EXECUTION_PLAN',
        model: 'generator-model',
        startedAt: 1_000,
        error: expect.any(ProviderTimeoutError),
      }));
    } finally {
      dateNow.mockRestore();
    }
  });

  test('does not mark or persist a plan rejected by the auditor', async () => {
    const recommendation = { id: 'rec-1', title: 'review', description: 'test' } as never;
    const snapshot = { tenantId: 'tenant-1' } as never;
    const findById = vi.fn().mockResolvedValue(recommendation);
    const createExecutionPlan = vi.fn();
    const generateAuditedPlan = vi.fn().mockResolvedValue({
      content: { summary: 'draft' },
      auditReport: {
        verdict: 'REJECTED',
        score: 40,
        checks: [],
        blockingIssues: [{ detail: 'synthetic-private-audit-detail' }],
        requiredChanges: [],
      },
      firstRawResponse: '{}',
    });
    const recordTrace = vi.fn();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const runner = new FinOpsAiExecutionPlanRunner(
      { getLatestTenantSnapshot: vi.fn().mockResolvedValue(snapshot) } as never,
      { findById, createExecutionPlan } as never,
      { assembleExecutionPlanContext: vi.fn().mockResolvedValue({ systemPrompt: 'prompt' }) } as never,
      { generateAuditedPlan } as never,
      { record: recordTrace } as never,
      'generator-model',
      'auditor-model',
    );

    try {
      await expect(runner.run({ tenantId: 'tenant-1', userId: 'user-1', recommendationId: 'rec-1' }))
        .rejects.toBeInstanceOf(AiAuditRejectedError);
      expect(createExecutionPlan).not.toHaveBeenCalled();
      expect(recordTrace).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'EXECUTION_PLAN',
        error: expect.any(Error),
      }));
      const tracedError = recordTrace.mock.calls[0]?.[0].error as Error;
      expect(tracedError.message).toContain('failedChecks=0');
      expect(tracedError.message).toContain('blockers=1');
      expect(tracedError.message).not.toContain('synthetic-private-audit-detail');
    } finally {
      dateNow.mockRestore();
    }
  });
});

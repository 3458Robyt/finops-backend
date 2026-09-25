import { describe, expect, test, vi } from 'vitest';
import { ProviderTimeoutError } from '../../../domain/errors/errors.js';
import { FinOpsAiExecutionPlanRunner } from './FinOpsAiExecutionPlanRunner.js';

describe('FinOpsAiExecutionPlanRunner', () => {
  test('starts the deadline before data preparation and never persists after generation timeout', async () => {
    const recommendation = { id: 'rec-1', title: 'review', description: 'test' } as never;
    const snapshot = { tenantId: 'tenant-1' } as never;
    const findById = vi.fn().mockResolvedValue(recommendation);
    const createExecutionPlan = vi.fn();
    const generateAuditedPlan = vi.fn().mockRejectedValue(new ProviderTimeoutError());
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const runner = new FinOpsAiExecutionPlanRunner(
      { getLatestTenantSnapshot: vi.fn().mockResolvedValue(snapshot) } as never,
      { findById, createExecutionPlan } as never,
      { assembleExecutionPlanContext: vi.fn().mockResolvedValue({ systemPrompt: 'prompt' }) } as never,
      { generateAuditedPlan } as never,
      { record: vi.fn() } as never,
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
    } finally {
      dateNow.mockRestore();
    }
  });
});

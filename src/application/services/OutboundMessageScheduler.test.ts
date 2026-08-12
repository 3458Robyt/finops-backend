import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { OutboundMessageService } from './OutboundMessageService.js';
import { OutboundMessageScheduler } from './OutboundMessageScheduler.js';

describe('OutboundMessageScheduler', () => {
  it('drains at most the configured delivery batch before reminders', async () => {
    let processed = 0;
    const service = {
      processNextPendingDelivery: vi.fn(async () => {
        processed += 1;
        return { processed: processed <= 2 };
      }),
      sendSavingsReminders: vi.fn(async () => ({ deliveries: [], attemptedUsers: 0 })),
    } as unknown as OutboundMessageService;
    const scheduler = new OutboundMessageScheduler(service, actor, {
      intervalMinutes: 1440,
      deliveryBatchSize: 2,
      deliveryLeaseMs: 120_000,
      deliveryRetryBackoffMs: 30_000,
    });

    await scheduler.runOnce();

    expect(service.processNextPendingDelivery).toHaveBeenCalledTimes(2);
    expect(service.sendSavingsReminders).toHaveBeenCalledWith(actor);
  });
});

const actor: AuthContext = {
  userId: 'scheduler-user',
  tenantId: 'tenant-1',
  email: 'scheduler@example.com',
  role: 'MASTER_ADMIN',
  jwtId: 'scheduler-jwt',
};

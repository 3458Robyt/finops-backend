import { describe, expect, it, vi } from 'vitest';
import { PrismaProcessHeartbeatRepository } from './PrismaProcessHeartbeatRepository.js';

describe('PrismaProcessHeartbeatRepository', () => {
  it('upserts running state and clears stoppedAt on recovery', async () => {
    const prisma = {
      $transaction: vi.fn().mockImplementation(async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma)),
      runtimeProcessHeartbeat: {
        upsert: vi.fn().mockResolvedValue(undefined),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    const repository = new PrismaProcessHeartbeatRepository(prisma as never);
    const now = new Date('2026-08-12T14:00:00.000Z');

    await repository.upsert({ processId: 'worker-1', processRole: 'worker', pid: 7, startedAt: now, heartbeatAt: now });

    expect(prisma.runtimeProcessHeartbeat.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { processId: 'worker-1' },
      update: expect.objectContaining({ status: 'RUNNING', stoppedAt: null, lastHeartbeatAt: now }),
    }));
  });

  it('marks only a running process as stopped', async () => {
    const prisma = { runtimeProcessHeartbeat: {
      upsert: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
    }, $transaction: vi.fn().mockImplementation(async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma)) };
    const repository = new PrismaProcessHeartbeatRepository(prisma as never);
    const stoppedAt = new Date('2026-08-12T14:00:01.000Z');

    await expect(repository.markStopped('scheduler-1', stoppedAt)).resolves.toBe(true);
    expect(prisma.runtimeProcessHeartbeat.updateMany).toHaveBeenCalledWith({
      where: { processId: 'scheduler-1', status: 'RUNNING' },
      data: { status: 'STOPPED', stoppedAt, lastHeartbeatAt: stoppedAt },
    });
  });
});

import { describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaIngestionJobLeaseReconciler } from './PrismaIngestionJobLeaseReconciler.js';

describe('PrismaIngestionJobLeaseReconciler', () => {
  test('requeues recoverable leases and closes exhausted or cancelled leases', async () => {
    const executeRaw = vi.fn()
      .mockResolvedValueOnce(1) // cancelled
      .mockResolvedValueOnce(2) // failed
      .mockResolvedValueOnce(3); // requeued
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ $executeRaw: executeRaw }));
    const prisma = { $transaction: transaction } as unknown as PrismaClient;
    const now = new Date('2026-08-29T12:00:00.000Z');

    const result = await new PrismaIngestionJobLeaseReconciler().reconcile(prisma, 300_000, now);

    expect(result).toEqual({ cancelled: 1, failed: 2, requeued: 3 });
    expect(transaction).toHaveBeenCalledOnce();
    expect(executeRaw).toHaveBeenCalledTimes(3);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaCloudIngestionReadRepository } from './PrismaCloudIngestionReadRepository.js';

describe('PrismaCloudIngestionReadRepository.cancelPendingIngestionJobs', () => {
  it('marks progress terminal and records the cancelling user atomically', async () => {
    let update: unknown;
    const updateMany = vi.fn(async (input: unknown) => {
      update = input;
      return { count: 2 };
    });
    const prisma = { ingestionJob: { updateMany } } as unknown as PrismaClient;
    const repository = new PrismaCloudIngestionReadRepository(prisma);

    const cancelled = await repository.cancelPendingIngestionJobs(
      'tenant-1', 'connection-1', 'TECHNICAL_METRIC', 'user-1',
    );

    expect(cancelled).toBe(2);
    expect(update).toMatchObject({
      where: {
        tenantId: 'tenant-1', cloudConnectionId: 'connection-1',
        sourceType: 'TECHNICAL_METRIC', status: 'PENDING',
      },
      data: {
        status: 'CANCELLED',
        cancelRequestedByUserId: 'user-1',
        errorMessage: 'Cancelado por el usuario.',
        progress: {
          phase: 'CANCELLED',
          message: 'Trabajo cancelado antes de iniciar.',
        },
      },
    });
    const data = (update as { data: { completedAt: Date; cancelRequestedAt: Date; progress: { updatedAt: string } } }).data;
    expect(data.cancelRequestedAt).toEqual(data.completedAt);
    expect(data.progress.updatedAt).toBe(data.completedAt.toISOString());
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PrismaAuthLifecycleCleanupRepository } from './PrismaAuthLifecycleCleanupRepository.js';

describe('PrismaAuthLifecycleCleanupRepository', () => {
  it('deletes only the bounded ids selected for each ephemeral artifact', async () => {
    const transaction = {
      authRefreshToken: modelDouble([{ id: 'refresh-1' }], 1),
      passwordResetToken: modelDouble([{ id: 'reset-1' }], 1),
      mfaChallenge: modelDouble([{ id: 'challenge-1' }], 1),
      authSession: modelDouble([{ id: 'session-1' }], 1),
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction)),
    };
    const repository = new PrismaAuthLifecycleCleanupRepository(prisma as never);

    const now = new Date('2026-08-12T12:00:00.000Z');
    await expect(repository.purgeExpiredArtifacts({
      now,
      batchSize: 10,
    })).resolves.toEqual({
      refreshTokens: 1,
      passwordResetTokens: 1,
      mfaChallenges: 1,
      sessions: 1,
    });

    expect(transaction.authRefreshToken.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
    expect(transaction.authRefreshToken.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { expiresAt: { lte: now } } }));
    expect(transaction.passwordResetToken.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { expiresAt: { lte: now } } }));
    expect(transaction.mfaChallenge.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { expiresAt: { lte: now } } }));
    expect(transaction.authSession.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        expiresAt: { lte: now },
        refreshTokens: { none: { expiresAt: { gt: now } } },
      },
    }));
    expect(transaction.authRefreshToken.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['refresh-1'] } } });
    expect(transaction.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['reset-1'] } } });
    expect(transaction.mfaChallenge.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['challenge-1'] } } });
    expect(transaction.authSession.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['session-1'] } } });
  });
});

function modelDouble(rows: readonly { readonly id: string }[], count: number) {
  return {
    findMany: vi.fn().mockResolvedValue(rows),
    deleteMany: vi.fn().mockResolvedValue({ count }),
  };
}

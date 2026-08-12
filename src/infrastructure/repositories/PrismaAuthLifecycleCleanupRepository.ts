import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type {
  AuthLifecycleCleanupInput,
  AuthLifecycleCleanupResult,
  IAuthLifecycleCleanupRepository,
} from '../../domain/interfaces/IAuthLifecycleCleanupRepository.js';

/** Prisma implementation used only from the authenticated maintenance worker. */
export class PrismaAuthLifecycleCleanupRepository implements IAuthLifecycleCleanupRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async purgeExpiredArtifacts(input: AuthLifecycleCleanupInput): Promise<AuthLifecycleCleanupResult> {
    return this.prisma.$transaction(async (transaction) => {
      const refreshTokens = await deleteRefreshTokens(transaction, input);
      const passwordResetTokens = await deletePasswordResetTokens(transaction, input);
      const mfaChallenges = await deleteMfaChallenges(transaction, input);
      const sessions = await deleteSessions(transaction, input);
      return { refreshTokens, passwordResetTokens, mfaChallenges, sessions };
    });
  }
}

async function deleteRefreshTokens(
  transaction: Prisma.TransactionClient,
  input: AuthLifecycleCleanupInput,
): Promise<number> {
  const rows = await transaction.authRefreshToken.findMany({
    where: { expiresAt: { lte: input.now } },
    orderBy: { id: 'asc' },
    take: input.batchSize,
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  return (await transaction.authRefreshToken.deleteMany({ where: { id: { in: rows.map((row: { id: string }) => row.id) } } })).count;
}

async function deletePasswordResetTokens(transaction: Prisma.TransactionClient, input: AuthLifecycleCleanupInput): Promise<number> {
  const rows = await transaction.passwordResetToken.findMany({
    where: { expiresAt: { lte: input.now } },
    orderBy: { id: 'asc' },
    take: input.batchSize,
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  return (await transaction.passwordResetToken.deleteMany({ where: { id: { in: rows.map((row: { id: string }) => row.id) } } })).count;
}

async function deleteMfaChallenges(transaction: Prisma.TransactionClient, input: AuthLifecycleCleanupInput): Promise<number> {
  const rows = await transaction.mfaChallenge.findMany({
    where: { expiresAt: { lte: input.now } },
    orderBy: { id: 'asc' },
    take: input.batchSize,
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  return (await transaction.mfaChallenge.deleteMany({ where: { id: { in: rows.map((row: { id: string }) => row.id) } } })).count;
}

async function deleteSessions(transaction: Prisma.TransactionClient, input: AuthLifecycleCleanupInput): Promise<number> {
  const rows = await transaction.authSession.findMany({
    where: {
      expiresAt: { lte: input.now },
      // Never let a session delete cascade into a refresh token that is still
      // valid if a malformed or manually imported record has mismatched TTLs.
      refreshTokens: { none: { expiresAt: { gt: input.now } } },
    },
    orderBy: { id: 'asc' },
    take: input.batchSize,
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  return (await transaction.authSession.deleteMany({ where: { id: { in: rows.map((row: { id: string }) => row.id) } } })).count;
}

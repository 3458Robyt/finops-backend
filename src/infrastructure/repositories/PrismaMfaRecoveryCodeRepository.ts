import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type {
  CompleteMfaEnrollmentWithRecoveryCodesInput,
  ConsumeMfaRecoveryChallengeInput,
  DisableMfaInput,
  IMfaRecoveryCodeRepository,
  MfaRecoveryCodeSet,
  VerifyTotpAndReplaceRecoveryCodesInput,
} from '../../domain/interfaces/IMfaRecoveryCodeRepository.js';

class ConcurrentMfaRecoveryUpdate extends Error {}

export class PrismaMfaRecoveryCodeRepository implements IMfaRecoveryCodeRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public countActive(userId: string): Promise<number> {
    return this.prisma.mfaRecoveryCode.count({
      where: { userId, usedAt: null, revokedAt: null },
    });
  }

  public enableMfaWithCodes(input: VerifyTotpAndReplaceRecoveryCodesInput): Promise<boolean> {
    return this.runAtomic(async (transaction) => {
      const updated = await transaction.userMfa.updateMany({
        where: {
          userId: input.userId,
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: input.usedStep } }],
        },
        data: { enabledAt: new Date(), lastUsedStep: input.usedStep },
      });
      if (updated.count !== 1) return false;
      await replaceActiveCodes(transaction, input.userId, input.recoveryCodes);
      return true;
    });
  }

  public completeEnrollmentWithCodes(
    input: CompleteMfaEnrollmentWithRecoveryCodesInput,
  ): Promise<boolean> {
    return this.runAtomic(async (transaction) => {
      const now = new Date();
      const challenge = await transaction.mfaChallenge.findUnique({
        where: { tokenHash: input.challengeTokenHash },
        select: { id: true, userId: true, purpose: true, expiresAt: true, consumedAt: true },
      });
      if (
        challenge === null
        || challenge.userId !== input.userId
        || challenge.purpose !== 'ENROLLMENT'
        || challenge.consumedAt !== null
        || challenge.expiresAt <= now
      ) return false;

      const updated = await transaction.userMfa.updateMany({
        where: {
          userId: input.userId,
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: input.usedStep } }],
        },
        data: { enabledAt: now, lastUsedStep: input.usedStep },
      });
      if (updated.count !== 1) return false;

      await replaceActiveCodes(transaction, input.userId, input.recoveryCodes, now);
      const consumed = await transaction.mfaChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new ConcurrentMfaRecoveryUpdate();
      return true;
    });
  }

  public replaceCodesWithTotp(input: VerifyTotpAndReplaceRecoveryCodesInput): Promise<boolean> {
    return this.runAtomic(async (transaction) => {
      const updated = await transaction.userMfa.updateMany({
        where: {
          userId: input.userId,
          enabledAt: { not: null },
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: input.usedStep } }],
        },
        data: { lastUsedStep: input.usedStep },
      });
      if (updated.count !== 1) return false;
      await replaceActiveCodes(transaction, input.userId, input.recoveryCodes);
      return true;
    });
  }

  public consumeLoginChallenge(input: ConsumeMfaRecoveryChallengeInput): Promise<boolean> {
    return this.runAtomic(async (transaction) => {
      const now = new Date();
      const challenge = await transaction.mfaChallenge.findUnique({
        where: { tokenHash: input.challengeTokenHash },
        select: { id: true, userId: true, purpose: true, expiresAt: true, consumedAt: true },
      });
      if (
        challenge === null
        || challenge.userId !== input.userId
        || challenge.purpose !== 'LOGIN'
        || challenge.consumedAt !== null
        || challenge.expiresAt <= now
      ) return false;

      const code = await transaction.mfaRecoveryCode.updateMany({
        where: {
          userId: input.userId,
          codeHash: input.codeHash,
          usedAt: null,
          revokedAt: null,
        },
        data: { usedAt: now },
      });
      if (code.count !== 1) return false;

      const consumed = await transaction.mfaChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new ConcurrentMfaRecoveryUpdate();
      return true;
    });
  }

  public disableMfa(input: DisableMfaInput): Promise<boolean> {
    return this.runAtomic(async (transaction) => {
      const removed = await transaction.userMfa.deleteMany({
        where: {
          userId: input.userId,
          enabledAt: { not: null },
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: input.usedStep } }],
        },
      });
      if (removed.count !== 1) return false;

      await transaction.mfaRecoveryCode.updateMany({
        where: { userId: input.userId, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return true;
    });
  }

  private async runAtomic(operation: (transaction: Prisma.TransactionClient) => Promise<boolean>): Promise<boolean> {
    try {
      return await this.prisma.$transaction(operation);
    } catch (error: unknown) {
      if (error instanceof ConcurrentMfaRecoveryUpdate) return false;
      throw error;
    }
  }
}

async function replaceActiveCodes(
  transaction: Prisma.TransactionClient,
  userId: string,
  recoveryCodes: MfaRecoveryCodeSet,
  now = new Date(),
): Promise<void> {
  await transaction.mfaRecoveryCode.updateMany({
    where: { userId, usedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  await transaction.mfaRecoveryCode.createMany({
    data: recoveryCodes.codeHashes.map((codeHash) => ({
      userId,
      batchId: recoveryCodes.batchId,
      codeHash,
    })),
  });
}

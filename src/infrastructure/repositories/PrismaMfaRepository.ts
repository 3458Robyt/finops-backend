import type { PrismaClient } from '../../generated/prisma/client.js';
import type {
  ConsumeMfaInput,
  CreateMfaChallengeInput,
  IMfaRepository,
  MfaChallengeRecord,
  MfaRecord,
  SaveMfaSecretInput,
} from '../../domain/interfaces/IMfaRepository.js';

export class PrismaMfaRepository implements IMfaRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findMfa(userId: string): Promise<MfaRecord | null> {
    const mfa = await this.prisma.userMfa.findUnique({
      where: { userId },
      select: {
        userId: true,
        encryptedSecret: true,
        encryptionIv: true,
        encryptionAuthTag: true,
        encryptionAlgorithm: true,
        encryptionKeyVersion: true,
        enabledAt: true,
        lastUsedStep: true,
      },
    });
    return mfa === null ? null : toMfaRecord(mfa);
  }

  public async savePendingMfa(input: SaveMfaSecretInput): Promise<void> {
    await this.prisma.userMfa.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        encryptedSecret: input.encryptedSecret,
        encryptionIv: input.encryptionIv,
        encryptionAuthTag: input.encryptionAuthTag,
        encryptionAlgorithm: input.encryptionAlgorithm,
        encryptionKeyVersion: input.encryptionKeyVersion,
      },
      update: {
        encryptedSecret: input.encryptedSecret,
        encryptionIv: input.encryptionIv,
        encryptionAuthTag: input.encryptionAuthTag,
        encryptionAlgorithm: input.encryptionAlgorithm,
        encryptionKeyVersion: input.encryptionKeyVersion,
        enabledAt: null,
        lastUsedStep: null,
      },
    });
  }

  public async enableMfa(input: ConsumeMfaInput): Promise<boolean> {
    const result = await this.prisma.userMfa.updateMany({
      where: {
        userId: input.userId,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: input.usedStep } }],
      },
      data: { enabledAt: new Date(), lastUsedStep: input.usedStep },
    });
    return result.count === 1;
  }

  public async createChallenge(input: CreateMfaChallengeInput): Promise<void> {
    await this.prisma.mfaChallenge.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      },
    });
  }

  public async findChallenge(tokenHash: string): Promise<MfaChallengeRecord | null> {
    const challenge = await this.prisma.mfaChallenge.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, tokenHash: true, purpose: true, expiresAt: true, consumedAt: true },
    });
    return challenge === null ? null : toChallengeRecord(challenge);
  }

  public async consumeChallenge(input: ConsumeMfaInput): Promise<boolean> {
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const challenge = await transaction.mfaChallenge.findUnique({
        where: { tokenHash: input.challengeTokenHash },
        select: { id: true, userId: true, purpose: true, expiresAt: true, consumedAt: true },
      });
      if (
        challenge === null
        || challenge.userId !== input.userId
        || challenge.consumedAt !== null
        || challenge.expiresAt <= now
      ) return false;

      const mfaUpdate = await transaction.userMfa.updateMany({
        where: {
          userId: input.userId,
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: input.usedStep } }],
        },
        data: {
          lastUsedStep: input.usedStep,
          ...(input.enableMfa ? { enabledAt: now } : {}),
        },
      });
      if (mfaUpdate.count !== 1) return false;

      const challengeUpdate = await transaction.mfaChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { consumedAt: now },
      });
      return challengeUpdate.count === 1;
    });
  }
}

function toMfaRecord(mfa: {
  readonly userId: string;
  readonly encryptedSecret: string;
  readonly encryptionIv: string;
  readonly encryptionAuthTag: string;
  readonly encryptionAlgorithm: string;
  readonly encryptionKeyVersion: string;
  readonly enabledAt: Date | null;
  readonly lastUsedStep: bigint | null;
}): MfaRecord {
  return {
    userId: mfa.userId,
    encryptedSecret: mfa.encryptedSecret,
    encryptionIv: mfa.encryptionIv,
    encryptionAuthTag: mfa.encryptionAuthTag,
    encryptionAlgorithm: mfa.encryptionAlgorithm,
    encryptionKeyVersion: mfa.encryptionKeyVersion,
    ...(mfa.enabledAt === null ? {} : { enabledAt: mfa.enabledAt }),
    ...(mfa.lastUsedStep === null ? {} : { lastUsedStep: mfa.lastUsedStep }),
  };
}

function toChallengeRecord(challenge: {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly purpose: 'LOGIN' | 'ENROLLMENT';
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}): MfaChallengeRecord {
  return {
    id: challenge.id,
    userId: challenge.userId,
    tokenHash: challenge.tokenHash,
    purpose: challenge.purpose,
    expiresAt: challenge.expiresAt,
    ...(challenge.consumedAt === null ? {} : { consumedAt: challenge.consumedAt }),
  };
}

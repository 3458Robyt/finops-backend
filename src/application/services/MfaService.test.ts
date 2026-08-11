import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  ConsumeMfaInput,
  CreateMfaChallengeInput,
  IMfaRepository,
  MfaChallengeRecord,
  MfaRecord,
  SaveMfaSecretInput,
} from '../../domain/interfaces/IMfaRepository.js';
import type {
  CompleteMfaEnrollmentWithRecoveryCodesInput,
  ConsumeMfaRecoveryChallengeInput,
  IMfaRecoveryCodeRepository,
  VerifyTotpAndReplaceRecoveryCodesInput,
} from '../../domain/interfaces/IMfaRecoveryCodeRepository.js';
import type { ISecretCipher } from '../../domain/interfaces/ISecretCipher.js';
import { MfaService, hashMfaChallengeToken } from './MfaService.js';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_CODE = '287082';

class FakeMfaRepository implements IMfaRepository {
  public record: MfaRecord | null = {
    userId: 'user-1',
    encryptedSecret: RFC_SECRET,
    encryptionIv: 'iv',
    encryptionAuthTag: 'tag',
    encryptionAlgorithm: 'aes-256-gcm',
    encryptionKeyVersion: 'v1',
    enabledAt: new Date(0),
  };
  public challenge: MfaChallengeRecord | null = null;
  public consumed: ConsumeMfaInput | null = null;

  public async findMfa(): Promise<MfaRecord | null> { return this.record; }
  public async savePendingMfa(_input: SaveMfaSecretInput): Promise<void> {}
  public async enableMfa(): Promise<boolean> { return true; }
  public async createChallenge(_input: CreateMfaChallengeInput): Promise<void> {}
  public async findChallenge(): Promise<MfaChallengeRecord | null> { return this.challenge; }
  public async consumeChallenge(input: ConsumeMfaInput): Promise<boolean> {
    this.consumed = input;
    return true;
  }
}

class FakeRecoveryCodeRepository implements IMfaRecoveryCodeRepository {
  public enabled: VerifyTotpAndReplaceRecoveryCodesInput | null = null;
  public enrollment: CompleteMfaEnrollmentWithRecoveryCodesInput | null = null;
  public replacement: VerifyTotpAndReplaceRecoveryCodesInput | null = null;
  public recoveryLogin: ConsumeMfaRecoveryChallengeInput | null = null;
  public remaining = 7;

  public async countActive(): Promise<number> { return this.remaining; }
  public async enableMfaWithCodes(input: VerifyTotpAndReplaceRecoveryCodesInput): Promise<boolean> {
    this.enabled = input;
    return true;
  }
  public async completeEnrollmentWithCodes(input: CompleteMfaEnrollmentWithRecoveryCodesInput): Promise<boolean> {
    this.enrollment = input;
    return true;
  }
  public async replaceCodesWithTotp(input: VerifyTotpAndReplaceRecoveryCodesInput): Promise<boolean> {
    this.replacement = input;
    return true;
  }
  public async consumeLoginChallenge(input: ConsumeMfaRecoveryChallengeInput): Promise<boolean> {
    this.recoveryLogin = input;
    return true;
  }
}

const cipher: ISecretCipher = {
  encrypt: (payload) => ({
    encryptedPayload: String(payload['secret']),
    encryptionIv: 'iv',
    encryptionAuthTag: 'tag',
    encryptionAlgorithm: 'aes-256-gcm',
    encryptionKeyVersion: 'v1',
  }),
  decrypt: (payload) => ({ secret: payload.encryptedPayload }),
};

describe('MfaService recovery codes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(59_000);
  });
  afterEach(() => vi.useRealTimers());

  test('returns plaintext recovery codes once while persisting hashes only', async () => {
    const mfa = new FakeMfaRepository();
    const recovery = new FakeRecoveryCodeRepository();
    const service = new MfaService(mfa, cipher, recovery);

    const codes = await service.confirmSetup('user-1', RFC_CODE);

    expect(codes).toHaveLength(10);
    expect(recovery.enabled?.userId).toBe('user-1');
    expect(recovery.enabled?.usedStep).toBe(1n);
    expect(recovery.enabled?.recoveryCodes.codeHashes).toHaveLength(10);
    expect(recovery.enabled?.recoveryCodes.codeHashes).not.toContain(codes[0]);
  });

  test('consumes a recovery code atomically with its login challenge', async () => {
    const token = 'valid-mfa-challenge-token-with-more-than-32-characters';
    const mfa = new FakeMfaRepository();
    mfa.challenge = {
      id: 'challenge-1',
      userId: 'user-1',
      tokenHash: hashMfaChallengeToken(token),
      purpose: 'LOGIN',
      expiresAt: new Date(120_000),
    };
    const recovery = new FakeRecoveryCodeRepository();
    const service = new MfaService(mfa, cipher, recovery);

    const result = await service.verifyLoginChallenge(token, 'ABCDE-12345-FABCD-67890');

    expect(result).toEqual({ userId: 'user-1', method: 'RECOVERY_CODE' });
    expect(recovery.recoveryLogin).toMatchObject({
      challengeTokenHash: hashMfaChallengeToken(token),
      userId: 'user-1',
    });
    expect(recovery.recoveryLogin?.codeHash).not.toContain('ABCDE');
    expect(mfa.consumed).toBeNull();
  });

  test('regenerates the set only after a fresh TOTP verification', async () => {
    const recovery = new FakeRecoveryCodeRepository();
    const service = new MfaService(new FakeMfaRepository(), cipher, recovery);

    const codes = await service.regenerateRecoveryCodes('user-1', RFC_CODE);

    expect(codes).toHaveLength(10);
    expect(recovery.replacement?.usedStep).toBe(1n);
    expect(recovery.replacement?.recoveryCodes.codeHashes).not.toContain(codes[0]);
    await expect(service.recoveryCodeStatus('user-1')).resolves.toEqual({ remaining: 7 });
  });
});

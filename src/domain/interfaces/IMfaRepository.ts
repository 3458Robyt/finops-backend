export interface MfaRecord {
  readonly userId: string;
  readonly encryptedSecret: string;
  readonly encryptionIv: string;
  readonly encryptionAuthTag: string;
  readonly encryptionAlgorithm: string;
  readonly encryptionKeyVersion: string;
  readonly enabledAt?: Date;
  readonly lastUsedStep?: bigint;
}

export interface MfaChallengeRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly purpose: 'LOGIN' | 'ENROLLMENT';
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
}

export interface SaveMfaSecretInput {
  readonly userId: string;
  readonly encryptedSecret: string;
  readonly encryptionIv: string;
  readonly encryptionAuthTag: string;
  readonly encryptionAlgorithm: string;
  readonly encryptionKeyVersion: string;
}

export interface CreateMfaChallengeInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly purpose: 'LOGIN' | 'ENROLLMENT';
  readonly expiresAt: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface ConsumeMfaInput {
  readonly challengeTokenHash: string;
  readonly userId: string;
  readonly usedStep: bigint;
  readonly enableMfa: boolean;
}

export interface IMfaRepository {
  findMfa(userId: string): Promise<MfaRecord | null>;
  savePendingMfa(input: SaveMfaSecretInput): Promise<void>;
  enableMfa(input: ConsumeMfaInput): Promise<boolean>;
  createChallenge(input: CreateMfaChallengeInput): Promise<void>;
  findChallenge(tokenHash: string): Promise<MfaChallengeRecord | null>;
  consumeChallenge(input: ConsumeMfaInput): Promise<boolean>;
}

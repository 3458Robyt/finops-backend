export interface MfaRecoveryCodeSet {
  readonly batchId: string;
  readonly codeHashes: readonly string[];
}

export interface VerifyTotpAndReplaceRecoveryCodesInput {
  readonly userId: string;
  readonly usedStep: bigint;
  readonly recoveryCodes: MfaRecoveryCodeSet;
}

export interface CompleteMfaEnrollmentWithRecoveryCodesInput
  extends VerifyTotpAndReplaceRecoveryCodesInput {
  readonly challengeTokenHash: string;
}

export interface ConsumeMfaRecoveryChallengeInput {
  readonly challengeTokenHash: string;
  readonly userId: string;
  readonly codeHash: string;
}

/** Atomic persistence contract for one-time MFA recovery codes. */
export interface IMfaRecoveryCodeRepository {
  countActive(userId: string): Promise<number>;
  enableMfaWithCodes(input: VerifyTotpAndReplaceRecoveryCodesInput): Promise<boolean>;
  completeEnrollmentWithCodes(input: CompleteMfaEnrollmentWithRecoveryCodesInput): Promise<boolean>;
  replaceCodesWithTotp(input: VerifyTotpAndReplaceRecoveryCodesInput): Promise<boolean>;
  consumeLoginChallenge(input: ConsumeMfaRecoveryChallengeInput): Promise<boolean>;
}

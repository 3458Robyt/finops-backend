export interface AuthLifecycleCleanupInput {
  readonly now: Date;
  readonly batchSize: number;
}

export interface AuthLifecycleCleanupResult {
  readonly refreshTokens: number;
  readonly passwordResetTokens: number;
  readonly mfaChallenges: number;
  readonly sessions: number;
}

/**
 * Purges only short-lived authentication artifacts. Business and audit
 * records are deliberately outside this port.
 */
export interface IAuthLifecycleCleanupRepository {
  purgeExpiredArtifacts(input: AuthLifecycleCleanupInput): Promise<AuthLifecycleCleanupResult>;
}

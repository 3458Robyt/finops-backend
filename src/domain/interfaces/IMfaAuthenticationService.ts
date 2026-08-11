export interface MfaLoginChallenge {
  readonly challengeToken: string;
  readonly expiresAt: Date;
}

export interface MfaLoginVerification {
  readonly userId: string;
  readonly method: 'TOTP' | 'RECOVERY_CODE';
}

export interface MfaEnrollmentVerification {
  readonly userId: string;
  readonly recoveryCodes: readonly string[];
}

export interface IMfaAuthenticationService {
  isEnabled(userId: string): Promise<boolean>;
  createLoginChallenge(input: {
    readonly userId: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<MfaLoginChallenge>;
  verifyLoginChallenge(challengeToken: string, code: string): Promise<MfaLoginVerification>;
  beginEnrollment(input: {
    readonly userId: string;
    readonly email: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<MfaLoginChallenge & { readonly secret: string; readonly otpauthUri: string }>;
  completeEnrollment(challengeToken: string, code: string): Promise<MfaEnrollmentVerification>;
}

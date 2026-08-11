export interface MfaLoginChallenge {
  readonly challengeToken: string;
  readonly expiresAt: Date;
}

export interface IMfaAuthenticationService {
  isEnabled(userId: string): Promise<boolean>;
  createLoginChallenge(input: {
    readonly userId: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<MfaLoginChallenge>;
  verifyLoginChallenge(challengeToken: string, code: string): Promise<string>;
  beginEnrollment(input: {
    readonly userId: string;
    readonly email: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<MfaLoginChallenge & { readonly secret: string; readonly otpauthUri: string }>;
  completeEnrollment(challengeToken: string, code: string): Promise<string>;
}

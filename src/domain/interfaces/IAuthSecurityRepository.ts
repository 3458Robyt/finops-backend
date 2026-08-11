export interface AuthRefreshTokenRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly usedAt?: Date;
  readonly revokedAt?: Date;
}

export interface CreateRefreshTokenInput {
  readonly sessionJwtId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly familyId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface RotateRefreshTokenInput {
  readonly tokenHash: string;
  readonly replacementTokenHash: string;
  readonly replacementExpiresAt: Date;
  readonly newJwtId: string;
  readonly sessionExpiresAt: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface IAuthSecurityRepository {
  findRefreshToken(tokenHash: string): Promise<AuthRefreshTokenRecord | null>;
  createRefreshToken(input: CreateRefreshTokenInput): Promise<void>;
  rotateRefreshToken(input: RotateRefreshTokenInput): Promise<boolean>;
  revokeRefreshFamily(familyId: string): Promise<void>;
  revokeRefreshTokensForSession(sessionId: string): Promise<void>;
  revokeRefreshTokensForUser(userId: string, exceptSessionId?: string): Promise<void>;
}

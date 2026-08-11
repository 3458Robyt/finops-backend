import type { AuthContext } from '../models/AuthContext.js';

export interface AuthSessionSummary {
  readonly id: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly isCurrent: boolean;
}

export interface IAuthSessionRepository {
  isActive(input: AuthContext): Promise<boolean>;
  revokeCurrent(actor: AuthContext): Promise<boolean>;
  revokeAll(userId: string, exceptJwtId?: string): Promise<number>;
  listActive(userId: string, currentJwtId: string): Promise<readonly AuthSessionSummary[]>;
  revokeById(userId: string, sessionId: string): Promise<boolean>;
}

import type { AuthContext } from '../models/AuthContext.js';

export interface TokenIssueResult {
  readonly token: string;
  readonly jwtId: string;
  readonly expiresAt: Date;
}

export interface ITokenService {
  issueToken(context: Omit<AuthContext, 'jwtId'>): TokenIssueResult;
  verifyToken(token: string): AuthContext;
}

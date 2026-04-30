import type { UserRole } from '../models/AuthContext.js';

export interface AuthUser {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly status: 'ACTIVE' | 'DISABLED';
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly jwtId: string;
  readonly expiresAt: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface IUserRepository {
  findByEmail(email: string): Promise<AuthUser | null>;
  updateLastLogin(userId: string, loggedInAt: Date): Promise<void>;
  createSession(input: CreateSessionInput): Promise<void>;
}

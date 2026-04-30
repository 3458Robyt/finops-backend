export type UserRole = 'ADMIN' | 'VIEWER';

export interface AuthContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: UserRole;
  readonly jwtId: string;
}

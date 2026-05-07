export type UserRole =
  | 'ADMIN'
  | 'VIEWER'
  | 'OPERATOR_ADMIN'
  | 'FINOPS_TECHNICIAN'
  | 'CLIENT_APPROVER'
  | 'CLIENT_VIEWER';

export interface AuthContext {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: UserRole;
  readonly jwtId: string;
}

import type { AccessibleTenant } from '../../domain/interfaces/IUserRepository.js';
import type { UserRole } from '../../domain/models/AuthContext.js';

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface SwitchTenantInput {
  readonly actor: import('../../domain/models/AuthContext.js').AuthContext;
  readonly tenantId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface AuthTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly accessRole: AccessibleTenant['accessRole'];
  readonly isCurrent: boolean;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly expiresAt: Date;
  readonly refreshToken?: string;
  readonly user: {
    readonly id: string;
    readonly tenantId: string;
    readonly homeTenantId: string;
    readonly email: string;
    readonly name: string;
    readonly role: UserRole;
  };
  readonly activeTenant: AuthTenant;
  readonly availableTenants: readonly AuthTenant[];
  /** One-time plaintext recovery codes returned only immediately after MFA enrollment. */
  readonly mfaRecoveryCodes?: readonly string[];
}

export interface MfaRequiredResult {
  readonly mfaRequired: true;
  readonly mfaSetupRequired?: boolean;
  readonly challengeToken: string;
  readonly expiresAt: Date;
  readonly secret?: string;
  readonly otpauthUri?: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly role: UserRole;
  };
}

export type AuthLoginResult = LoginResult | MfaRequiredResult;

export interface AuthDatabaseContext {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly role?: UserRole;
  readonly refreshTokenHash?: string;
  readonly passwordResetTokenHash?: string;
}

export type AuthDatabaseContextRunner = <T>(context: AuthDatabaseContext, callback: () => T) => T;

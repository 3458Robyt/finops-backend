import type { AuthUser, IUserRepository } from '../../domain/interfaces/IUserRepository.js';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { ITokenService } from '../../domain/interfaces/ITokenService.js';
import type { IAuthSessionRepository, AuthSessionSummary } from '../../domain/interfaces/IAuthSessionRepository.js';
import type { IAuthSecurityRepository } from '../../domain/interfaces/IAuthSecurityRepository.js';
import type { IMfaAuthenticationService } from '../../domain/interfaces/IMfaAuthenticationService.js';
import type { AuthContext, UserRole } from '../../domain/models/AuthContext.js';
import { AuthenticationError, AuthorizationError } from '../../domain/errors/errors.js';
import type {
  AuthDatabaseContextRunner,
  AuthLoginResult,
  AuthTenant,
  LoginInput,
  LoginResult,
  MfaRequiredResult,
  SwitchTenantInput,
} from '../auth/authTypes.js';
import { AuthRefreshService } from '../auth/AuthRefreshService.js';
import { AuthSessionIssuer } from '../auth/AuthSessionIssuer.js';
export { hashOpaqueToken } from '../auth/opaqueToken.js';
export type {
  AuthDatabaseContextRunner,
  AuthLoginResult,
  AuthTenant,
  LoginInput,
  LoginResult,
  MfaRequiredResult,
  SwitchTenantInput,
} from '../auth/authTypes.js';

export class AuthService {
  private readonly issuer: AuthSessionIssuer;
  private readonly refreshService: AuthRefreshService;

  constructor(
    private readonly users: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
    tokenService: ITokenService,
    private readonly sessions: IAuthSessionRepository,
    security: IAuthSecurityRepository | undefined = undefined,
    private readonly runInDatabaseContext: AuthDatabaseContextRunner = (_context, callback) => callback(),
    private readonly mfa?: IMfaAuthenticationService,
  ) {
    this.issuer = new AuthSessionIssuer(users, tokenService, security);
    this.refreshService = new AuthRefreshService(users, tokenService, security, this.issuer, this.runInDatabaseContext);
  }

  public async login(input: LoginInput): Promise<AuthLoginResult> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const user = await this.users.findByEmail(normalizedEmail);

    if (user === null || user.status !== 'ACTIVE') {
      throw new AuthenticationError();
    }

    const passwordMatches = await this.passwordHasher.verify(user.passwordHash, input.password);
    if (!passwordMatches) {
      throw new AuthenticationError();
    }

    const mfaEnabled = this.mfa !== undefined && await this.mfa.isEnabled(user.id);
    if (mfaEnabled) {
      const challenge = await this.mfa.createLoginChallenge({
        userId: user.id,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      });
      return {
        mfaRequired: true,
        challengeToken: challenge.challengeToken,
        expiresAt: challenge.expiresAt,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    }

    if (this.mfa !== undefined && requiresPrivilegedMfa(user.role)) {
      const enrollment = await this.mfa.beginEnrollment({
        userId: user.id,
        email: user.email,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      });
      return {
        mfaRequired: true,
        mfaSetupRequired: true,
        challengeToken: enrollment.challengeToken,
        expiresAt: enrollment.expiresAt,
        secret: enrollment.secret,
        otpauthUri: enrollment.otpauthUri,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      };
    }

    const result = await this.issuer.issue({
      user,
      activeTenantId: user.tenantId,
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });

    await this.users.updateLastLogin(user.id, new Date());

    return result;
  }

  public async completeMfaLogin(input: {
    readonly challengeToken: string;
    readonly code: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<LoginResult> {
    if (this.mfa === undefined) throw new AuthenticationError('MFA no está disponible.');
    const verification = await this.mfa.verifyLoginChallenge(input.challengeToken, input.code);
    const user = await this.runInDatabaseContext({ userId: verification.userId }, () => this.findActiveUser(verification.userId));
    return this.runInDatabaseContext({ userId: user.id, tenantId: user.tenantId, role: user.role }, () => this.issuer.issue({
      user,
      activeTenantId: user.tenantId,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    }));
  }

  public async completeMfaEnrollment(input: {
    readonly challengeToken: string;
    readonly code: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<LoginResult> {
    if (this.mfa === undefined) throw new AuthenticationError('MFA no está disponible.');
    const verification = await this.mfa.completeEnrollment(input.challengeToken, input.code);
    const user = await this.runInDatabaseContext({ userId: verification.userId }, () => this.findActiveUser(verification.userId));
    const session = await this.runInDatabaseContext({ userId: user.id, tenantId: user.tenantId, role: user.role }, () => this.issuer.issue({
      user,
      activeTenantId: user.tenantId,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    }));
    return { ...session, mfaRecoveryCodes: verification.recoveryCodes };
  }

  public async listAccessibleTenants(actor: AuthContext): Promise<readonly AuthTenant[]> {
    const user = await this.findActiveUser(actor.userId);
    const tenants = await this.users.listAccessibleTenants(user);
    return this.issuer.toAuthTenants(tenants, actor.tenantId);
  }

  public async switchTenant(input: SwitchTenantInput): Promise<LoginResult> {
    const user = await this.findActiveUser(input.actor.userId);
    const accessibleTenants = await this.users.listAccessibleTenants(user);
    if (!accessibleTenants.some((tenant) => tenant.id === input.tenantId)) {
      throw new AuthorizationError();
    }

    const revoked = await this.sessions.revokeCurrent(input.actor);
    if (!revoked) {
      throw new AuthenticationError('La sesión ya no está activa. Inicia sesión nuevamente.');
    }

    return this.issuer.issue({
      user,
      activeTenantId: input.tenantId,
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });
  }

  public refresh(input: {
    readonly refreshToken: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<LoginResult> {
    return this.refreshService.refresh(input);
  }

  public async logout(actor: AuthContext): Promise<void> {
    await this.sessions.revokeCurrent(actor);
  }

  public async logoutAll(actor: AuthContext): Promise<void> {
    await this.sessions.revokeAll(actor.userId);
  }

  public listSessions(actor: AuthContext): Promise<readonly AuthSessionSummary[]> {
    return this.sessions.listActive(actor.userId, actor.jwtId);
  }

  public async revokeSession(actor: AuthContext, sessionId: string): Promise<void> {
    const revoked = await this.sessions.revokeById(actor.userId, sessionId);
    if (!revoked) {
      throw new AuthorizationError('La sesión no existe o ya fue revocada.');
    }
  }

  private async findActiveUser(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (user === null || user.status !== 'ACTIVE') {
      throw new AuthenticationError();
    }

    return user;
  }

}

function requiresPrivilegedMfa(role: UserRole): boolean {
  return process.env['MFA_REQUIRED_FOR_PRIVILEGED'] === 'true'
    && ['ADMIN', 'MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN'].includes(role);
}

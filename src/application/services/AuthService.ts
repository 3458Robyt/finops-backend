import type { AccessibleTenant, AuthUser, IUserRepository } from '../../domain/interfaces/IUserRepository.js';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { ITokenService } from '../../domain/interfaces/ITokenService.js';
import type { AuthContext, UserRole } from '../../domain/models/AuthContext.js';
import { AuthenticationError, AuthorizationError } from '../../domain/errors/errors.js';

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface SwitchTenantInput {
  readonly actor: AuthContext;
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
}

export class AuthService {
  constructor(
    private readonly users: IUserRepository,
    private readonly passwordHasher: IPasswordHasher,
    private readonly tokenService: ITokenService,
  ) {}

  public async login(input: LoginInput): Promise<LoginResult> {
    const normalizedEmail = input.email.trim().toLowerCase();
    const user = await this.users.findByEmail(normalizedEmail);

    if (user === null || user.status !== 'ACTIVE') {
      throw new AuthenticationError();
    }

    const passwordMatches = await this.passwordHasher.verify(user.passwordHash, input.password);
    if (!passwordMatches) {
      throw new AuthenticationError();
    }

    const result = await this.issueTenantScopedSession({
      user,
      activeTenantId: user.tenantId,
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });

    await this.users.updateLastLogin(user.id, new Date());

    return result;
  }

  public async listAccessibleTenants(actor: AuthContext): Promise<readonly AuthTenant[]> {
    const user = await this.findActiveUser(actor.userId);
    const tenants = await this.users.listAccessibleTenants(user);
    return this.toAuthTenants(tenants, actor.tenantId);
  }

  public async switchTenant(input: SwitchTenantInput): Promise<LoginResult> {
    const user = await this.findActiveUser(input.actor.userId);
    return this.issueTenantScopedSession({
      user,
      activeTenantId: input.tenantId,
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });
  }

  private async findActiveUser(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (user === null || user.status !== 'ACTIVE') {
      throw new AuthenticationError();
    }

    return user;
  }

  private async issueTenantScopedSession(input: {
    readonly user: AuthUser;
    readonly activeTenantId: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<LoginResult> {
    const accessibleTenants = await this.users.listAccessibleTenants(input.user);
    const activeTenant = accessibleTenants.find((tenant) => tenant.id === input.activeTenantId);

    if (activeTenant === undefined) {
      throw new AuthorizationError();
    }

    const token = this.tokenService.issueToken({
      userId: input.user.id,
      tenantId: activeTenant.id,
      email: input.user.email,
      role: input.user.role,
    });

    await this.users.createSession({
      userId: input.user.id,
      jwtId: token.jwtId,
      expiresAt: token.expiresAt,
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });

    return {
      accessToken: token.token,
      expiresAt: token.expiresAt,
      user: {
        id: input.user.id,
        tenantId: activeTenant.id,
        homeTenantId: input.user.tenantId,
        email: input.user.email,
        name: input.user.name,
        role: input.user.role,
      },
      activeTenant: this.toAuthTenant(activeTenant, activeTenant.id),
      availableTenants: this.toAuthTenants(accessibleTenants, activeTenant.id),
    };
  }

  private toAuthTenants(
    tenants: readonly AccessibleTenant[],
    activeTenantId: string,
  ): readonly AuthTenant[] {
    return tenants.map((tenant) => this.toAuthTenant(tenant, activeTenantId));
  }

  private toAuthTenant(tenant: AccessibleTenant, activeTenantId: string): AuthTenant {
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      accessRole: tenant.accessRole,
      isCurrent: tenant.id === activeTenantId,
    };
  }
}

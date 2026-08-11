import { randomUUID } from 'node:crypto';
import type { AccessibleTenant, AuthUser, IUserRepository } from '../../domain/interfaces/IUserRepository.js';
import type { ITokenService, TokenIssueResult } from '../../domain/interfaces/ITokenService.js';
import type { IAuthSecurityRepository } from '../../domain/interfaces/IAuthSecurityRepository.js';
import type { AuthTenant, LoginResult } from './authTypes.js';
import { createOpaqueToken, DEFAULT_REFRESH_TOKEN_TTL_SECONDS, hashOpaqueToken } from './opaqueToken.js';
import { AuthorizationError } from '../../domain/errors/errors.js';

export class AuthSessionIssuer {
  public constructor(
    private readonly users: IUserRepository,
    private readonly tokenService: ITokenService,
    private readonly security?: IAuthSecurityRepository,
    private readonly refreshTokenTtlSeconds = DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  ) {}

  public async issue(input: {
    readonly user: AuthUser;
    readonly activeTenantId: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<LoginResult> {
    const accessibleTenants = await this.users.listAccessibleTenants(input.user);
    const activeTenant = accessibleTenants.find((tenant) => tenant.id === input.activeTenantId);
    if (activeTenant === undefined) throw new AuthorizationError();

    const access = this.tokenService.issueToken({
      userId: input.user.id,
      tenantId: activeTenant.id,
      email: input.user.email,
      role: input.user.role,
    });
    const refresh = this.security === undefined ? undefined : createOpaqueToken(this.refreshTokenTtlSeconds);

    await this.users.createSession({
      userId: input.user.id,
      tenantId: activeTenant.id,
      jwtId: access.jwtId,
      expiresAt: refresh?.expiresAt ?? access.expiresAt,
      ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    });

    if (refresh !== undefined) {
      await this.security!.createRefreshToken({
        sessionJwtId: access.jwtId,
        userId: input.user.id,
        tenantId: activeTenant.id,
        familyId: randomUUID(),
        tokenHash: hashOpaqueToken(refresh.value),
        expiresAt: refresh.expiresAt,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      });
    }

    return this.toLoginResult({
      user: input.user,
      accessibleTenants,
      activeTenantId: activeTenant.id,
      accessToken: access,
      ...(refresh === undefined ? {} : { refreshToken: refresh.value }),
    });
  }

  public toAuthTenants(tenants: readonly AccessibleTenant[], activeTenantId: string): readonly AuthTenant[] {
    return tenants.map((tenant) => ({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      accessRole: tenant.accessRole,
      isCurrent: tenant.id === activeTenantId,
    }));
  }

  public toLoginResult(input: {
    readonly user: AuthUser;
    readonly accessibleTenants: readonly AccessibleTenant[];
    readonly activeTenantId: string;
    readonly accessToken: TokenIssueResult;
    readonly refreshToken?: string;
  }): LoginResult {
    const activeTenant = input.accessibleTenants.find((tenant) => tenant.id === input.activeTenantId);
    if (activeTenant === undefined) throw new AuthorizationError();
    return {
      accessToken: input.accessToken.token,
      expiresAt: input.accessToken.expiresAt,
      ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
      user: {
        id: input.user.id,
        tenantId: activeTenant.id,
        homeTenantId: input.user.tenantId,
        email: input.user.email,
        name: input.user.name,
        role: input.user.role,
      },
      activeTenant: {
        id: activeTenant.id,
        name: activeTenant.name,
        slug: activeTenant.slug,
        accessRole: activeTenant.accessRole,
        isCurrent: true,
      },
      availableTenants: this.toAuthTenants(input.accessibleTenants, activeTenant.id),
    };
  }
}

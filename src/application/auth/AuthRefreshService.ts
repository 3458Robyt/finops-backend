import type { AuthUser, IUserRepository } from '../../domain/interfaces/IUserRepository.js';
import type { ITokenService } from '../../domain/interfaces/ITokenService.js';
import type { IAuthSecurityRepository } from '../../domain/interfaces/IAuthSecurityRepository.js';
import { AuthenticationError } from '../../domain/errors/errors.js';
import type { AuthDatabaseContextRunner, LoginResult } from './authTypes.js';
import { AuthSessionIssuer } from './AuthSessionIssuer.js';
import { createOpaqueToken, hashOpaqueToken } from './opaqueToken.js';

export class AuthRefreshService {
  public constructor(
    private readonly users: IUserRepository,
    private readonly tokenService: ITokenService,
    private readonly security: IAuthSecurityRepository | undefined,
    private readonly issuer: AuthSessionIssuer,
    private readonly runInDatabaseContext: AuthDatabaseContextRunner,
  ) {}

  public async refresh(input: {
    readonly refreshToken: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
  }): Promise<LoginResult> {
    if (this.security === undefined || input.refreshToken.trim() === '') {
      throw new AuthenticationError('La sesión de renovación no es válida. Inicia sesión nuevamente.');
    }
    const tokenHash = hashOpaqueToken(input.refreshToken);
    const current = await this.security.findRefreshToken(tokenHash);
    if (current === null) throw new AuthenticationError('La sesión de renovación no es válida. Inicia sesión nuevamente.');

    if (current.usedAt !== undefined || current.revokedAt !== undefined || current.expiresAt <= new Date()) {
      if (current.usedAt !== undefined) await this.security.revokeRefreshFamily(current.familyId);
      throw new AuthenticationError('La sesión de renovación expiró o ya fue utilizada. Inicia sesión nuevamente.');
    }

    const user = await this.findActiveUser(current.userId);
    return this.runInDatabaseContext({
      userId: user.id,
      tenantId: current.tenantId,
      role: user.role,
      refreshTokenHash: tokenHash,
    }, async () => {
      const accessibleTenants = await this.users.listAccessibleTenants(user);
      const activeTenant = accessibleTenants.find((tenant) => tenant.id === current.tenantId);
      if (activeTenant === undefined) {
        await this.security!.revokeRefreshFamily(current.familyId);
        throw new AuthenticationError('El tenant activo ya no está disponible.');
      }

      const access = this.tokenService.issueToken({
        userId: user.id,
        tenantId: activeTenant.id,
        email: user.email,
        role: user.role,
      });
      const replacement = createOpaqueToken();
      const rotated = await this.security!.rotateRefreshToken({
        tokenHash,
        replacementTokenHash: hashOpaqueToken(replacement.value),
        replacementExpiresAt: replacement.expiresAt,
        newJwtId: access.jwtId,
        sessionExpiresAt: replacement.expiresAt,
        ...(input.ipAddress === undefined ? {} : { ipAddress: input.ipAddress }),
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      });
      if (!rotated) {
        const replayed = await this.security!.findRefreshToken(tokenHash);
        if (replayed?.usedAt !== undefined) await this.security!.revokeRefreshFamily(replayed.familyId);
        throw new AuthenticationError('La sesión de renovación ya no está activa. Inicia sesión nuevamente.');
      }

      return this.issuer.toLoginResult({
        user,
        accessibleTenants,
        activeTenantId: activeTenant.id,
        accessToken: access,
        refreshToken: replacement.value,
      });
    });
  }

  private async findActiveUser(userId: string): Promise<AuthUser> {
    const user = await this.users.findById(userId);
    if (user === null || user.status !== 'ACTIVE') throw new AuthenticationError();
    return user;
  }
}

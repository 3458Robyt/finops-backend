import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { ITokenService } from '../../domain/interfaces/ITokenService.js';
import type { IUserRepository } from '../../domain/interfaces/IUserRepository.js';
import { AuthenticationError } from '../../domain/errors/errors.js';

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface LoginResult {
  readonly accessToken: string;
  readonly expiresAt: Date;
  readonly user: {
    readonly id: string;
    readonly tenantId: string;
    readonly email: string;
    readonly name: string;
    readonly role: 'ADMIN' | 'VIEWER';
  };
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

    const passwordMatches = await this.passwordHasher.verify(
      user.passwordHash,
      input.password,
    );

    if (!passwordMatches) {
      throw new AuthenticationError();
    }

    const token = this.tokenService.issueToken({
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
    });

    await this.users.createSession({
      userId: user.id,
      jwtId: token.jwtId,
      expiresAt: token.expiresAt,
      ...(input.ipAddress !== undefined ? { ipAddress: input.ipAddress } : {}),
      ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
    });

    await this.users.updateLastLogin(user.id, new Date());

    return {
      accessToken: token.token,
      expiresAt: token.expiresAt,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }
}

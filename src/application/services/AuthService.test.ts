import { describe, expect, test } from 'vitest';
import { AuthService } from './AuthService.js';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { ITokenService, TokenIssueResult } from '../../domain/interfaces/ITokenService.js';
import type {
  AuthUser,
  CreateSessionInput,
  IUserRepository,
} from '../../domain/interfaces/IUserRepository.js';
import { AuthenticationError } from '../../domain/errors/errors.js';

class FakeUserRepository implements IUserRepository {
  public createdSession: CreateSessionInput | null = null;
  public updatedLastLoginUserId: string | null = null;

  constructor(private readonly user: AuthUser | null) {}

  public async findByEmail(): Promise<AuthUser | null> {
    return this.user;
  }

  public async updateLastLogin(userId: string): Promise<void> {
    this.updatedLastLoginUserId = userId;
  }

  public async createSession(input: CreateSessionInput): Promise<void> {
    this.createdSession = input;
  }
}

class FakePasswordHasher implements IPasswordHasher {
  constructor(private readonly matches: boolean) {}

  public async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  public async verify(): Promise<boolean> {
    return this.matches;
  }
}

class FakeTokenService implements ITokenService {
  public issueToken(): TokenIssueResult {
    return {
      token: 'signed.jwt',
      jwtId: 'jwt-1',
      expiresAt: new Date('2026-04-28T12:00:00.000Z'),
    };
  }

  public verifyToken() {
    throw new Error('not used');
  }
}

const activeUser: AuthUser = {
  id: 'user-1',
  tenantId: 'tenant-1',
  email: 'admin@example.com',
  name: 'Admin',
  passwordHash: 'hash',
  role: 'ADMIN',
  status: 'ACTIVE',
};

describe('AuthService', () => {
  test('issues a token and records a session for valid credentials', async () => {
    const users = new FakeUserRepository(activeUser);
    const service = new AuthService(
      users,
      new FakePasswordHasher(true),
      new FakeTokenService(),
    );

    const result = await service.login({
      email: 'ADMIN@EXAMPLE.COM ',
      password: 'secret',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });

    expect(result.accessToken).toBe('signed.jwt');
    expect(result.user).toEqual({
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'admin@example.com',
      name: 'Admin',
      role: 'ADMIN',
    });
    expect(users.createdSession).toMatchObject({
      userId: 'user-1',
      jwtId: 'jwt-1',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(users.updatedLastLoginUserId).toBe('user-1');
  });

  test('rejects invalid credentials without recording a session', async () => {
    const users = new FakeUserRepository(activeUser);
    const service = new AuthService(
      users,
      new FakePasswordHasher(false),
      new FakeTokenService(),
    );

    await expect(service.login({ email: 'admin@example.com', password: 'bad' }))
      .rejects
      .toBeInstanceOf(AuthenticationError);

    expect(users.createdSession).toBeNull();
    expect(users.updatedLastLoginUserId).toBeNull();
  });

  test('rejects disabled users', async () => {
    const users = new FakeUserRepository({
      ...activeUser,
      status: 'DISABLED',
    });
    const service = new AuthService(
      users,
      new FakePasswordHasher(true),
      new FakeTokenService(),
    );

    await expect(service.login({ email: 'admin@example.com', password: 'secret' }))
      .rejects
      .toBeInstanceOf(AuthenticationError);
  });
});

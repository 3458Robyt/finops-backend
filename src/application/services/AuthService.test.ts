import { describe, expect, test } from 'vitest';
import { AuthService } from './AuthService.js';
import type { IPasswordHasher } from '../../domain/interfaces/IPasswordHasher.js';
import type { ITokenService, TokenIssueResult } from '../../domain/interfaces/ITokenService.js';
import type {
  AccessibleTenant,
  AuthUser,
  CreateSessionInput,
  IUserRepository,
} from '../../domain/interfaces/IUserRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import { AuthenticationError, AuthorizationError } from '../../domain/errors/errors.js';

class FakeUserRepository implements IUserRepository {
  public createdSession: CreateSessionInput | null = null;
  public updatedLastLoginUserId: string | null = null;
  public findByIdUser: AuthUser | null;

  public constructor(
    private readonly user: AuthUser | null,
    private readonly tenants: readonly AccessibleTenant[] = [
      { id: 'tenant-1', name: 'Tenant Principal', slug: 'tenant-principal', accessRole: 'HOME' },
    ],
  ) {
    this.findByIdUser = user;
  }

  public async findByEmail(): Promise<AuthUser | null> {
    return this.user;
  }

  public async findById(): Promise<AuthUser | null> {
    return this.findByIdUser;
  }

  public async listAccessibleTenants(): Promise<readonly AccessibleTenant[]> {
    return this.tenants;
  }

  public async updateLastLogin(userId: string): Promise<void> {
    this.updatedLastLoginUserId = userId;
  }

  public async createSession(input: CreateSessionInput): Promise<void> {
    this.createdSession = input;
  }
}

class FakePasswordHasher implements IPasswordHasher {
  public constructor(private readonly matches: boolean) {}

  public async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  public async verify(): Promise<boolean> {
    return this.matches;
  }
}

class FakeTokenService implements ITokenService {
  public issuedContexts: Omit<AuthContext, 'jwtId'>[] = [];

  public issueToken(context: Omit<AuthContext, 'jwtId'>): TokenIssueResult {
    this.issuedContexts.push(context);
    return {
      token: `signed.jwt.${context.tenantId}`,
      jwtId: `jwt-${this.issuedContexts.length}`,
      expiresAt: new Date('2026-04-28T12:00:00.000Z'),
    };
  }

  public verifyToken(): AuthContext {
    throw new Error('not used');
  }
}

const activeUser: AuthUser = {
  id: 'user-1',
  tenantId: 'tenant-1',
  email: 'admin@example.com',
  name: 'Admin User',
  passwordHash: 'hash',
  role: 'ADMIN',
  status: 'ACTIVE',
};

describe('AuthService', () => {
  test('logs in and returns active tenant plus available tenants', async () => {
    const tenants: readonly AccessibleTenant[] = [
      { id: 'tenant-1', name: 'Tenant Principal', slug: 'tenant-principal', accessRole: 'HOME' },
      { id: 'tenant-2', name: 'Cliente Dos', slug: 'cliente-dos', accessRole: 'TECHNICIAN' },
    ];
    const users = new FakeUserRepository(activeUser, tenants);
    const tokenService = new FakeTokenService();
    const service = new AuthService(users, new FakePasswordHasher(true), tokenService);

    const result = await service.login({
      email: 'ADMIN@EXAMPLE.COM ',
      password: 'secret',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });

    expect(result.accessToken).toBe('signed.jwt.tenant-1');
    expect(result.user).toMatchObject({
      id: 'user-1',
      tenantId: 'tenant-1',
      homeTenantId: 'tenant-1',
      role: 'ADMIN',
    });
    expect(result.activeTenant).toMatchObject({ id: 'tenant-1', isCurrent: true });
    expect(result.availableTenants).toHaveLength(2);
    expect(tokenService.issuedContexts[0]).toMatchObject({ tenantId: 'tenant-1' });
    expect(users.createdSession).toMatchObject({
      userId: 'user-1',
      jwtId: 'jwt-1',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(users.updatedLastLoginUserId).toBe('user-1');
  });

  test('switches to an assigned tenant by issuing a tenant-scoped token', async () => {
    const tenants: readonly AccessibleTenant[] = [
      { id: 'tenant-1', name: 'Tenant Principal', slug: 'tenant-principal', accessRole: 'HOME' },
      { id: 'tenant-2', name: 'Cliente Dos', slug: 'cliente-dos', accessRole: 'TECHNICIAN' },
    ];
    const users = new FakeUserRepository(activeUser, tenants);
    const tokenService = new FakeTokenService();
    const service = new AuthService(users, new FakePasswordHasher(true), tokenService);

    const result = await service.switchTenant({
      actor: buildActor('tenant-1'),
      tenantId: 'tenant-2',
    });

    expect(result.accessToken).toBe('signed.jwt.tenant-2');
    expect(result.user.tenantId).toBe('tenant-2');
    expect(result.user.homeTenantId).toBe('tenant-1');
    expect(result.activeTenant).toMatchObject({ id: 'tenant-2', isCurrent: true });
    expect(result.availableTenants.map((tenant) => tenant.isCurrent)).toEqual([false, true]);
  });

  test('rejects switch to a tenant outside accessible tenants', async () => {
    const users = new FakeUserRepository(activeUser);
    const service = new AuthService(users, new FakePasswordHasher(true), new FakeTokenService());

    await expect(service.switchTenant({
      actor: buildActor('tenant-1'),
      tenantId: 'tenant-999',
    })).rejects.toBeInstanceOf(AuthorizationError);
  });

  test('rejects invalid credentials without recording a session', async () => {
    const users = new FakeUserRepository(activeUser);
    const service = new AuthService(users, new FakePasswordHasher(false), new FakeTokenService());

    await expect(service.login({ email: 'admin@example.com', password: 'bad' }))
      .rejects
      .toBeInstanceOf(AuthenticationError);

    expect(users.createdSession).toBeNull();
    expect(users.updatedLastLoginUserId).toBeNull();
  });

  test('rejects disabled users', async () => {
    const users = new FakeUserRepository({ ...activeUser, status: 'DISABLED' });
    const service = new AuthService(users, new FakePasswordHasher(true), new FakeTokenService());

    await expect(service.login({ email: 'admin@example.com', password: 'secret' }))
      .rejects
      .toBeInstanceOf(AuthenticationError);
  });
});

function buildActor(tenantId: string): AuthContext {
  return {
    userId: 'user-1',
    tenantId,
    email: 'admin@example.com',
    role: 'ADMIN',
    jwtId: 'jwt-current',
  };
}

import { describe, expect, test, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { IAuthSessionRepository, AuthSessionSummary } from '../../domain/interfaces/IAuthSessionRepository.js';
import type { ITokenService } from '../../domain/interfaces/ITokenService.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import { createAuthMiddleware } from './authMiddleware.js';

const auth: AuthContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  email: 'user@example.com',
  role: 'ADMIN',
  jwtId: 'jwt-1',
};

class FakeTokenService implements ITokenService {
  public issueToken(): never { throw new Error('not used'); }
  public verifyToken(): AuthContext { return auth; }
}

class FakeSessionRepository implements IAuthSessionRepository {
  public constructor(private readonly active: boolean) {}
  public async isActive(): Promise<boolean> { return this.active; }
  public async revokeCurrent(): Promise<boolean> { return true; }
  public async revokeAll(): Promise<number> { return 0; }
  public async listActive(): Promise<readonly AuthSessionSummary[]> { return []; }
  public async revokeById(): Promise<boolean> { return true; }
}

function buildRequest(): Request {
  return {
    header: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer signed-token' : undefined,
  } as unknown as Request;
}

function buildResponse(): Response & { statusCode?: number; body?: unknown } {
  const response = {
    locals: { requestId: 'request-1' },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  } as unknown as Response & { statusCode?: number; body?: unknown };
  return response;
}

describe('createAuthMiddleware', () => {
  test('requires a persisted active session before continuing', async () => {
    const next = vi.fn();
    const response = buildResponse();
    const middleware = createAuthMiddleware(new FakeTokenService(), new FakeSessionRepository(true));

    await middleware(buildRequest(), response, next);

    expect(next).toHaveBeenCalledOnce();
  });

  test('rejects a validly signed token whose persisted session is revoked or absent', async () => {
    const next = vi.fn();
    const response = buildResponse();
    const middleware = createAuthMiddleware(new FakeTokenService(), new FakeSessionRepository(false));

    await middleware(buildRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
    expect(response.body).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });
});

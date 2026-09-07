import { describe, expect, test, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import { PrismaAuthSessionRepository } from './PrismaAuthSessionRepository.js';

function buildPrisma() {
  return {
    authSession: { findUnique: vi.fn() },
    tenant: { findFirst: vi.fn() },
    tenantAccessAssignment: { findFirst: vi.fn() },
  } as unknown as PrismaClient;
}

function context(role: AuthContext['role'], identityRole?: AuthContext['identityRole']): AuthContext {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    email: 'admin@example.com',
    role,
    ...(identityRole === undefined ? {} : { identityRole }),
    jwtId: 'jwt-1',
  };
}

describe('PrismaAuthSessionRepository effective roles', () => {
  test('accepts a new session when global ADMIN is normalized to operator for the home tenant', async () => {
    const prisma = buildPrisma();
    vi.mocked(prisma.authSession.findUnique).mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      user: { status: 'ACTIVE', role: 'ADMIN', tenantId: 'tenant-1' },
    } as never);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValue({ id: 'tenant-1' } as never);

    await expect(new PrismaAuthSessionRepository(prisma).isActive(context('OPERATOR_ADMIN', 'ADMIN'))).resolves.toBe(true);
    await expect(new PrismaAuthSessionRepository(prisma).isActive(context('ADMIN'))).resolves.toBe(false);
  });

  test('checks the current assignment role for a switched-tenant session', async () => {
    const prisma = buildPrisma();
    vi.mocked(prisma.authSession.findUnique).mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-2',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      user: { status: 'ACTIVE', role: 'ADMIN', tenantId: 'tenant-1' },
    } as never);
    vi.mocked(prisma.tenantAccessAssignment.findFirst).mockResolvedValue({ role: 'LEAD_TECHNICIAN' } as never);

    const repository = new PrismaAuthSessionRepository(prisma);
    await expect(repository.isActive({ ...context('LEAD_TECHNICIAN', 'ADMIN'), tenantId: 'tenant-2' })).resolves.toBe(true);
    await expect(repository.isActive({ ...context('OPERATOR_ADMIN', 'ADMIN'), tenantId: 'tenant-2' })).resolves.toBe(false);
  });
});

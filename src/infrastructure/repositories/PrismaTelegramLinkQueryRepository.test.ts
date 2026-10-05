import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaTelegramLinkQueryRepository } from './PrismaTelegramLinkQueryRepository.js';

describe('PrismaTelegramLinkQueryRepository tenant options', () => {
  it('lists every active tenant for a master admin even without explicit assignments', async () => {
    const activeTenants = [tenant('demo-org', 'FinOps Demo'), tenant('demo-client', 'Demo Client')];
    const findMany = vi.fn(async () => activeTenants);
    const repository = createRepository({
      user: user('MASTER_ADMIN', []),
      findMany,
    });

    const options = await repository.findTenantOptionsForUser('master-1', 'demo-client');

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'ACTIVE' } }));
    expect(options).toEqual([
      { ...activeTenants[0], isActive: false },
      { ...activeTenants[1], isActive: true },
    ]);
  });

  it('limits non-master options to the active home tenant and active assignments', async () => {
    const assignedTenant = tenant('demo-client', 'Demo Client');
    const repository = createRepository({
      user: {
        ...user('OPERATOR_ADMIN', [{ tenant: assignedTenant }]),
        tenant: { ...tenant('home', 'Home'), status: 'ACTIVE' },
      },
    });

    const options = await repository.findTenantOptionsForUser('admin-1', 'home');

    expect(options).toEqual([
      { id: 'home', name: 'Home', slug: 'home', isActive: true },
      { ...assignedTenant, isActive: false },
    ]);
  });
});

function createRepository(input: {
  readonly user: Record<string, unknown>;
  readonly findMany?: ReturnType<typeof vi.fn>;
}) {
  const prisma = {
    user: { findUnique: vi.fn(async () => input.user) },
    tenant: { findMany: input.findMany ?? vi.fn(async () => []) },
  } as unknown as PrismaClient;
  return new PrismaTelegramLinkQueryRepository(prisma);
}

function user(role: string, tenantAccessAssignments: readonly unknown[]) {
  return {
    tenantId: 'home',
    role,
    tenant: { ...tenant('home', 'Home'), status: 'ACTIVE' },
    tenantAccessAssignments,
  };
}

function tenant(id: string, name: string) {
  return { id, name, slug: id };
}

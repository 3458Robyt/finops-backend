import { describe, expect, it, vi } from 'vitest';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { PrismaTelegramRepository } from './PrismaTelegramRepository.js';

describe('PrismaTelegramRepository', () => {
  it('switches an existing user chat to the selected tenant without reassigning its owner', async () => {
    const existing = telegramLink({ tenantId: 'tak-colombia', userId: 'admin-1' });
    const { repository, upsert } = repositoryFor(existing);

    const result = await repository.consumeSelfLinkCode({
      tokenHash: 'hashed-code',
      chatId: existing.chatId,
    });

    expect(result).toMatchObject({ tenantId: 'tak-colombia', activeTenantId: 'tak-2', userId: 'admin-1' });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ activeTenantId: 'tak-2' }),
    }));
    expect(upsert.mock.calls[0]?.[0].update).not.toHaveProperty('tenantId');
  });

  it('rejects a self-link code that targets a chat owned by another user', async () => {
    const existing = telegramLink({ userId: 'someone-else' });
    const { repository } = repositoryFor(existing);

    await expect(repository.consumeSelfLinkCode({ tokenHash: 'hashed-code', chatId: existing.chatId }))
      .rejects.toMatchObject<Partial<FinOpsBaseError>>({ code: 'CONFLICT' });
  });
});

function repositoryFor(existing: ReturnType<typeof telegramLink>) {
  const upsert = vi.fn(async (args: { readonly update: Record<string, unknown> }) => ({
    ...existing,
    ...args.update,
    user: linkedUser(),
  }));
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    telegramLinkCode: {
      findFirst: vi.fn(async () => ({ id: 'code-1', tenantId: 'tak-2', userId: 'admin-1' })),
      update: vi.fn(async () => ({})),
    },
    telegramChatLink: {
      findUnique: vi.fn(async () => existing),
      findFirst: vi.fn(async () => existing.userId === 'admin-1' ? { chatId: existing.chatId } : null),
      upsert,
    },
  };
  const prisma = {
    $transaction: async <T>(operation: (transaction: unknown) => Promise<T>) => operation(tx),
  } as unknown as PrismaClient;
  return { repository: new PrismaTelegramRepository(prisma), upsert };
}

function telegramLink(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-10-04T00:00:00.000Z');
  return {
    id: 'link-1',
    tenantId: 'tak-colombia',
    userId: 'admin-1',
    chatId: 'chat-1',
    activeTenantId: null,
    telegramUserId: null,
    telegramUsername: null,
    status: 'ACTIVE',
    linkedByUserId: 'admin-1',
    disabledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function linkedUser() {
  return {
    id: 'admin-1',
    tenantId: 'tak-colombia',
    email: 'admin@example.test',
    name: 'Admin',
    role: 'MASTER_ADMIN',
    status: 'ACTIVE',
  };
}

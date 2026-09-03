import type { PrismaClient } from '../../generated/prisma/client.js';
import type { TelegramChatLink, TelegramTenantOption } from '../../domain/models/Telegram.js';
import { toChatLink } from './mappers/telegramMappers.js';
import { telegramUserSelect } from './mappers/telegramRepositorySelects.js';

/** Consultas de lectura y selección de tenant del canal Telegram. */
export class PrismaTelegramLinkQueryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findUserByEmailInTenant(tenantId: string, email: string) {
    const user = await this.prisma.user.findFirst({
      where: { tenantId, email: email.toLowerCase() },
      select: telegramUserSelect,
    });
    return user;
  }

  public async findLinksByTenant(tenantId: string): Promise<TelegramChatLink[]> {
    const rows = await this.prisma.telegramChatLink.findMany({
      where: { OR: [{ tenantId }, { activeTenantId: tenantId }] },
      include: { user: { select: telegramUserSelect } },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
    return rows.map((row) => toChatLink(row));
  }

  public async findLinkById(tenantId: string, id: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findFirst({
      where: { id, OR: [{ tenantId }, { activeTenantId: tenantId }] },
      include: { user: { select: telegramUserSelect } },
    });
    return row === null ? null : toChatLink(row);
  }

  public async findActiveLinkByChatId(chatId: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findUnique({
      where: { chatId },
      include: { user: { select: telegramUserSelect } },
    });
    return row === null || row.status !== 'ACTIVE' ? null : toChatLink(row);
  }

  public async findAnyLinkByChatId(chatId: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findUnique({
      where: { chatId },
      include: { user: { select: telegramUserSelect } },
    });
    return row === null ? null : toChatLink(row);
  }

  public async findActiveLinkByUserId(userId: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findFirst({
      where: { userId, status: 'ACTIVE' },
      include: { user: { select: telegramUserSelect } },
    });
    return row === null ? null : toChatLink(row);
  }

  public async findTenantOptionsForUser(userId: string, activeTenantId: string): Promise<readonly TelegramTenantOption[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        tenantId: true,
        role: true,
        tenant: { select: { id: true, name: true, slug: true } },
        tenantAccessAssignments: {
          where: { disabledAt: null },
          select: { tenant: { select: { id: true, name: true, slug: true } } },
        },
      },
    });
    if (user === null) return [];

    const tenants = new Map<string, { readonly id: string; readonly name: string; readonly slug: string }>();
    tenants.set(user.tenant.id, user.tenant);
    if (user.role !== 'CLIENT_APPROVER' && user.role !== 'CLIENT_VIEWER') {
      for (const assignment of user.tenantAccessAssignments) tenants.set(assignment.tenant.id, assignment.tenant);
    }
    return [...tenants.values()]
      .sort((left, right) => left.name.localeCompare(right.name, 'es'))
      .map((tenant) => ({ ...tenant, isActive: tenant.id === activeTenantId }));
  }

  public async setActiveTenantForChat(input: { readonly chatId: string; readonly userId: string; readonly tenantId: string }): Promise<TelegramChatLink | null> {
    const options = await this.findTenantOptionsForUser(input.userId, input.tenantId);
    if (!options.some((tenant) => tenant.id === input.tenantId)) return null;

    const updatedCount = await this.prisma.telegramChatLink.updateMany({
      where: { chatId: input.chatId, userId: input.userId, status: 'ACTIVE' },
      data: { activeTenantId: input.tenantId },
    });
    if (updatedCount.count === 0) return null;

    const updated = await this.findAnyLinkByChatId(input.chatId);
    return updated;
  }
}

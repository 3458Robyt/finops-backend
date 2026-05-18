import type {
  CreateOrUpdateTelegramLinkInput,
  CreateTelegramAuditEventInput,
  CreateTelegramInteractionLogInput,
  ITelegramRepository,
} from '../../domain/interfaces/ITelegramRepository.js';
import type {
  TelegramChatLink,
  TelegramInteractionLog,
  TelegramLinkedUser,
} from '../../domain/models/Telegram.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

const userSelect = {
  id: true,
  tenantId: true,
  email: true,
  name: true,
  role: true,
  status: true,
} as const;

export class PrismaTelegramRepository implements ITelegramRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async findUserByEmailInTenant(tenantId: string, email: string): Promise<TelegramLinkedUser | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        tenantId,
        email: email.toLowerCase(),
      },
      select: userSelect,
    });

    return user === null ? null : this.toLinkedUser(user);
  }

  public async findLinksByTenant(tenantId: string): Promise<TelegramChatLink[]> {
    const rows = await this.prisma.telegramChatLink.findMany({
      where: { tenantId },
      include: { user: { select: userSelect } },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    return rows.map((row) => this.toChatLink(row));
  }

  public async findLinkById(tenantId: string, id: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findFirst({
      where: { id, tenantId },
      include: { user: { select: userSelect } },
    });

    return row === null ? null : this.toChatLink(row);
  }

  public async findActiveLinkByChatId(chatId: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findUnique({
      where: { chatId },
      include: { user: { select: userSelect } },
    });

    if (row === null || row.status !== 'ACTIVE') {
      return null;
    }

    return this.toChatLink(row);
  }

  public async findAnyLinkByChatId(chatId: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findUnique({
      where: { chatId },
      include: { user: { select: userSelect } },
    });

    return row === null ? null : this.toChatLink(row);
  }

  public async createOrUpdateLink(input: CreateOrUpdateTelegramLinkInput): Promise<TelegramChatLink> {
    const row = await this.prisma.telegramChatLink.upsert({
      where: { chatId: input.chatId },
      update: {
        tenantId: input.tenantId,
        userId: input.userId,
        ...(input.telegramUserId !== undefined ? { telegramUserId: input.telegramUserId } : {}),
        ...(input.telegramUsername !== undefined ? { telegramUsername: input.telegramUsername } : {}),
        linkedByUserId: input.linkedByUserId,
        status: 'ACTIVE',
        disabledAt: null,
      },
      create: {
        tenantId: input.tenantId,
        userId: input.userId,
        chatId: input.chatId,
        ...(input.telegramUserId !== undefined ? { telegramUserId: input.telegramUserId } : {}),
        ...(input.telegramUsername !== undefined ? { telegramUsername: input.telegramUsername } : {}),
        linkedByUserId: input.linkedByUserId,
      },
      include: { user: { select: userSelect } },
    });

    return this.toChatLink(row);
  }

  public async disableLink(tenantId: string, id: string): Promise<TelegramChatLink | null> {
    const existing = await this.prisma.telegramChatLink.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });

    if (existing === null) {
      return null;
    }

    const row = await this.prisma.telegramChatLink.update({
      where: { id },
      data: {
        status: 'DISABLED',
        disabledAt: new Date(),
      },
      include: { user: { select: userSelect } },
    });

    return this.toChatLink(row);
  }

  public async createInteractionLog(input: CreateTelegramInteractionLogInput): Promise<TelegramInteractionLog> {
    const row = await this.prisma.telegramInteractionLog.create({
      data: {
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        chatId: input.chatId,
        ...(input.telegramUserId !== undefined ? { telegramUserId: input.telegramUserId } : {}),
        ...(input.telegramUsername !== undefined ? { telegramUsername: input.telegramUsername } : {}),
        ...(input.command !== undefined ? { command: input.command } : {}),
        status: input.status,
        ...(input.textPreview !== undefined ? { textPreview: input.textPreview } : {}),
        ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    return this.toInteractionLog(row);
  }

  public async createAuditEvent(input: CreateTelegramAuditEventInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        ...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  private toChatLink(row: {
    readonly id: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly telegramUserId: string | null;
    readonly telegramUsername: string | null;
    readonly status: string;
    readonly linkedByUserId: string;
    readonly disabledAt: Date | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly user?: {
      readonly id: string;
      readonly tenantId: string;
      readonly email: string;
      readonly name: string;
      readonly role: TelegramLinkedUser['role'];
      readonly status: TelegramLinkedUser['status'];
    };
  }): TelegramChatLink {
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      chatId: row.chatId,
      ...(row.telegramUserId !== null ? { telegramUserId: row.telegramUserId } : {}),
      ...(row.telegramUsername !== null ? { telegramUsername: row.telegramUsername } : {}),
      status: row.status as TelegramChatLink['status'],
      linkedByUserId: row.linkedByUserId,
      ...(row.disabledAt !== null ? { disabledAt: row.disabledAt } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.user !== undefined ? { user: this.toLinkedUser(row.user) } : {}),
    };
  }

  private toInteractionLog(row: {
    readonly id: string;
    readonly tenantId: string | null;
    readonly userId: string | null;
    readonly chatId: string;
    readonly telegramUserId: string | null;
    readonly telegramUsername: string | null;
    readonly command: string | null;
    readonly status: string;
    readonly textPreview: string | null;
    readonly errorMessage: string | null;
    readonly metadata: unknown;
    readonly createdAt: Date;
  }): TelegramInteractionLog {
    return {
      id: row.id,
      ...(row.tenantId !== null ? { tenantId: row.tenantId } : {}),
      ...(row.userId !== null ? { userId: row.userId } : {}),
      chatId: row.chatId,
      ...(row.telegramUserId !== null ? { telegramUserId: row.telegramUserId } : {}),
      ...(row.telegramUsername !== null ? { telegramUsername: row.telegramUsername } : {}),
      ...(row.command !== null ? { command: row.command } : {}),
      status: row.status as TelegramInteractionLog['status'],
      ...(row.textPreview !== null ? { textPreview: row.textPreview } : {}),
      ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
      ...(row.metadata !== null ? { metadata: row.metadata } : {}),
      createdAt: row.createdAt,
    };
  }

  private toLinkedUser(row: {
    readonly id: string;
    readonly tenantId: string;
    readonly email: string;
    readonly name: string;
    readonly role: TelegramLinkedUser['role'];
    readonly status: TelegramLinkedUser['status'];
  }): TelegramLinkedUser {
    return {
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      name: row.name,
      role: row.role,
      status: row.status,
    };
  }
}

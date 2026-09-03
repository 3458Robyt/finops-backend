import type {
  ConsumeTelegramSelfLinkCodeInput,
  CreateOrUpdateTelegramLinkInput,
  CreateTelegramAuditEventInput,
  CreateTelegramInteractionLogInput,
  CreateTelegramSelfLinkCodeInput,
  ClaimTelegramInboundUpdateInput,
  CompleteTelegramInboundUpdateInput,
  CreateTelegramInboundUpdateInput,
  ITelegramRepository,
} from '../../domain/interfaces/ITelegramRepository.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type {
  TelegramChatLink,
  TelegramInteractionLog,
  TelegramLinkedUser,
} from '../../domain/models/Telegram.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { toChatLink, toInteractionLog, toLinkedUser } from './mappers/telegramMappers.js';
import { telegramUserSelect as userSelect } from './mappers/telegramRepositorySelects.js';
import { PrismaTelegramLinkQueryRepository } from './PrismaTelegramLinkQueryRepository.js';
import { PrismaTelegramInboundUpdateRepository } from './PrismaTelegramInboundUpdateRepository.js';

/**
 * Adaptador de infraestructura (Clean Architecture) que implementa el puerto de
 * dominio {@link ITelegramRepository} sobre Prisma/PostgreSQL.
 *
 * Responsabilidad: gestionar la vinculación entre chats de Telegram y usuarios
 * del sistema (tabla `telegram_chat_links`), así como el registro de
 * interacciones (`telegram_interaction_logs`) y eventos de auditoría
 * (`audit_events`). Las consultas por tenant aplican aislamiento multi-tenant;
 * las búsquedas por `chatId` son globales porque `chatId` es único a nivel de
 * Telegram.
 */
export class PrismaTelegramRepository implements ITelegramRepository {
  private readonly linkQueries: PrismaTelegramLinkQueryRepository;
  private readonly inboundUpdates: PrismaTelegramInboundUpdateRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.linkQueries = new PrismaTelegramLinkQueryRepository(prisma);
    this.inboundUpdates = new PrismaTelegramInboundUpdateRepository(prisma);
  }

  /**
   * Busca un usuario por correo dentro de un tenant concreto, para vincularlo a
   * un chat de Telegram.
   *
   * El correo se normaliza a minúsculas antes de comparar. El filtro por
   * `tenantId` garantiza el aislamiento multi-tenant.
   *
   * @param tenantId Tenant en el que buscar.
   * @param email Correo del usuario (se compara en minúsculas).
   * @returns El usuario vinculable de dominio, o `null` si no existe en ese
   *   tenant.
   */
  public async findUserByEmailInTenant(tenantId: string, email: string): Promise<TelegramLinkedUser | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        tenantId,
        email: email.toLowerCase(),
      },
      select: userSelect,
    });

    return user === null ? null : toLinkedUser(user);
  }

  public async findLinksByTenant(tenantId: string): Promise<TelegramChatLink[]> {
    return this.linkQueries.findLinksByTenant(tenantId);
  }

  public async findLinkById(tenantId: string, id: string): Promise<TelegramChatLink | null> {
    return this.linkQueries.findLinkById(tenantId, id);
  }

  public async findActiveLinkByChatId(chatId: string): Promise<TelegramChatLink | null> {
    return this.linkQueries.findActiveLinkByChatId(chatId);
  }

  public async findTenantOptionsForUser(userId: string, activeTenantId: string) {
    return this.linkQueries.findTenantOptionsForUser(userId, activeTenantId);
  }

  public async setActiveTenantForChat(input: { readonly chatId: string; readonly userId: string; readonly tenantId: string }): Promise<TelegramChatLink | null> {
    return this.linkQueries.setActiveTenantForChat(input);
  }

  public async findAnyLinkByChatId(chatId: string): Promise<TelegramChatLink | null> {
    return this.linkQueries.findAnyLinkByChatId(chatId);
  }

  public async findActiveLinkByUserId(userId: string): Promise<TelegramChatLink | null> {
    return this.linkQueries.findActiveLinkByUserId(userId);
  }

  /**
   * Crea o reactiva (upsert por `chatId`) el vínculo entre un chat de Telegram y
   * un usuario.
   *
   * Si el `chatId` ya existe, lo actualiza reasignando tenant/usuario, lo marca
   * como `ACTIVE` y limpia `disabledAt` (reactivación). Si no existe, lo crea
   * nuevo. Los campos de Telegram opcionales solo se incluyen cuando están
   * definidos.
   *
   * @param input Datos del vínculo (tenant, usuario, chatId, metadatos de
   *   Telegram y quién lo vincula).
   * @returns El vínculo resultante de dominio, con su usuario asociado.
   */
  public async createOrUpdateLink(input: CreateOrUpdateTelegramLinkInput): Promise<TelegramChatLink> {
    const row = await this.prisma.telegramChatLink.upsert({
      where: { chatId: input.chatId },
      update: {
        tenantId: input.tenantId,
        userId: input.userId,
        ...(input.telegramUserId !== undefined ? { telegramUserId: input.telegramUserId } : {}),
        ...(input.telegramUsername !== undefined ? { telegramUsername: input.telegramUsername } : {}),
        linkedByUserId: input.linkedByUserId,
        activeTenantId: null,
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
        activeTenantId: null,
      },
      include: { user: { select: userSelect } },
    });

    return toChatLink(row);
  }

  /**
   * Guarda únicamente el hash de un código de auto-vinculación. El registro
   * queda protegido por RLS para que solo el usuario que lo solicitó pueda
   * verlo dentro del portal.
   */
  public async createSelfLinkCode(input: CreateTelegramSelfLinkCodeInput): Promise<void> {
    await this.prisma.telegramLinkCode.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      },
    });
  }

  /**
   * Consume de forma atómica un código de un solo uso y vincula el chat. El
   * hash se expone temporalmente mediante un GUC dentro de la transacción para
   * que el webhook pueda pasar RLS sin abrir acceso global a los códigos.
   */
  public async consumeSelfLinkCode(
    input: ConsumeTelegramSelfLinkCodeInput,
  ): Promise<TelegramChatLink | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT set_config('app.telegram_link_token_hash', ${input.tokenHash}, true)
      `);

      const code = await tx.telegramLinkCode.findFirst({
        where: {
          tokenHash: input.tokenHash,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      if (code === null) return null;

      const existing = await tx.telegramChatLink.findUnique({
        where: { chatId: input.chatId },
      });

      if (
        existing !== null
        && existing.status === 'ACTIVE'
        && (existing.tenantId !== code.tenantId || existing.userId !== code.userId)
      ) {
        throw new FinOpsBaseError('El chat de Telegram ya está vinculado a otra cuenta', 'CONFLICT');
      }

      const existingForUser = await tx.telegramChatLink.findFirst({
        where: { userId: code.userId, status: 'ACTIVE' },
        select: { chatId: true },
      });
      if (existingForUser !== null && existingForUser.chatId !== input.chatId) {
        throw new FinOpsBaseError('El usuario ya tiene otro chat de Telegram vinculado', 'CONFLICT');
      }

      const link = await tx.telegramChatLink.upsert({
        where: { chatId: input.chatId },
        update: {
          tenantId: code.tenantId,
          userId: code.userId,
          ...(input.telegramUserId === undefined ? {} : { telegramUserId: input.telegramUserId }),
          ...(input.telegramUsername === undefined ? {} : { telegramUsername: input.telegramUsername }),
          linkedByUserId: code.userId,
          activeTenantId: null,
          status: 'ACTIVE',
          disabledAt: null,
        },
        create: {
          tenantId: code.tenantId,
          userId: code.userId,
          chatId: input.chatId,
          ...(input.telegramUserId === undefined ? {} : { telegramUserId: input.telegramUserId }),
          ...(input.telegramUsername === undefined ? {} : { telegramUsername: input.telegramUsername }),
          linkedByUserId: code.userId,
          activeTenantId: null,
        },
        include: { user: { select: userSelect } },
      });

      await tx.telegramLinkCode.update({
        where: { id: code.id },
        data: { consumedAt: new Date() },
      });

      return toChatLink(link);
    });
  }

  /**
   * Deshabilita un vínculo de chat, validando previamente su pertenencia al
   * tenant.
   *
   * Comprueba la existencia del vínculo dentro del tenant (aislamiento
   * multi-tenant) antes de actualizar su estado a `DISABLED` y registrar
   * `disabledAt` con la fecha actual.
   *
   * @param tenantId Tenant propietario del vínculo.
   * @param id Identificador del vínculo a deshabilitar.
   * @returns El vínculo deshabilitado de dominio, o `null` si no existe o no
   *   pertenece al tenant.
   */
  public async disableLink(tenantId: string, id: string): Promise<TelegramChatLink | null> {
    const existing = await this.prisma.telegramChatLink.findFirst({
      where: { id, OR: [{ tenantId }, { activeTenantId: tenantId }] },
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

    return toChatLink(row);
  }

  /**
   * Registra una entrada en la bitácora de interacciones de Telegram (comandos,
   * mensajes, errores) para trazabilidad.
   *
   * `tenantId` y `userId` son opcionales porque una interacción puede provenir
   * de un chat aún no vinculado. `metadata` se serializa como JSON de Prisma.
   *
   * @param input Datos de la interacción a registrar.
   * @returns El registro de interacción de dominio.
   */
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

    return toInteractionLog(row);
  }

  /**
   * Registra un evento de auditoría asociado a acciones sobre Telegram (tabla
   * `audit_events`).
   *
   * Deja constancia del actor, la acción, el tipo de entidad y metadatos
   * opcionales para cumplimiento y trazabilidad. No devuelve valor.
   *
   * @param input Datos del evento de auditoría (tenant, actor, acción, entidad y
   *   metadatos opcionales).
   * @returns Promesa que se resuelve cuando el evento queda persistido.
   */
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

  public async enqueueInboundUpdate(input: CreateTelegramInboundUpdateInput): Promise<'ENQUEUED' | 'DUPLICATE'> {
    return this.inboundUpdates.enqueue(input);
  }

  public async claimNextInboundUpdate(input: ClaimTelegramInboundUpdateInput) {
    return this.inboundUpdates.claim(input);
  }

  public async completeInboundUpdate(input: CompleteTelegramInboundUpdateInput) {
    return this.inboundUpdates.complete(input);
  }
}

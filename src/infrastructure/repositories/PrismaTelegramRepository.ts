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
import { toChatLink, toInteractionLog, toLinkedUser } from './mappers/telegramMappers.js';

/**
 * Proyección de columnas de la tabla `users` reutilizada en las consultas de
 * Telegram. Limita los campos expuestos del usuario a los estrictamente
 * necesarios para vincular cuentas (evita filtrar credenciales u otros datos
 * sensibles).
 */
const userSelect = {
  id: true,
  tenantId: true,
  email: true,
  name: true,
  role: true,
  status: true,
} as const;

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
  constructor(private readonly prisma: PrismaClient) {}

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

  /**
   * Lista todos los vínculos de chat de Telegram de un tenant, incluyendo los
   * datos básicos del usuario asociado.
   *
   * Ordena por estado ascendente y, dentro de cada estado, por fecha de
   * actualización descendente. Filtra por `tenantId` (aislamiento multi-tenant).
   *
   * @param tenantId Tenant cuyos vínculos se listan.
   * @returns Lista de vínculos de dominio; arreglo vacío si no hay ninguno.
   */
  public async findLinksByTenant(tenantId: string): Promise<TelegramChatLink[]> {
    const rows = await this.prisma.telegramChatLink.findMany({
      where: { tenantId },
      include: { user: { select: userSelect } },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    return rows.map((row) => toChatLink(row));
  }

  /**
   * Busca un vínculo de chat por su identificador, restringido a un tenant.
   *
   * @param tenantId Tenant propietario del vínculo (aislamiento multi-tenant).
   * @param id Identificador del vínculo.
   * @returns El vínculo de dominio con su usuario, o `null` si no existe o no
   *   pertenece al tenant.
   */
  public async findLinkById(tenantId: string, id: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findFirst({
      where: { id, tenantId },
      include: { user: { select: userSelect } },
    });

    return row === null ? null : toChatLink(row);
  }

  /**
   * Busca el vínculo activo asociado a un `chatId` de Telegram.
   *
   * `chatId` es único globalmente en Telegram, por lo que la búsqueda no filtra
   * por tenant. Devuelve `null` si no existe vínculo o si su estado no es
   * `ACTIVE` (p. ej. fue deshabilitado).
   *
   * @param chatId Identificador del chat de Telegram.
   * @returns El vínculo activo de dominio, o `null` si no hay vínculo activo.
   */
  public async findActiveLinkByChatId(chatId: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findUnique({
      where: { chatId },
      include: { user: { select: userSelect } },
    });

    if (row === null || row.status !== 'ACTIVE') {
      return null;
    }

    return toChatLink(row);
  }

  /**
   * Busca cualquier vínculo asociado a un `chatId`, independientemente de su
   * estado (activo o deshabilitado).
   *
   * A diferencia de {@link findActiveLinkByChatId}, no filtra por estado; útil
   * para reactivar o inspeccionar vínculos existentes.
   *
   * @param chatId Identificador del chat de Telegram.
   * @returns El vínculo de dominio si existe, o `null` en caso contrario.
   */
  public async findAnyLinkByChatId(chatId: string): Promise<TelegramChatLink | null> {
    const row = await this.prisma.telegramChatLink.findUnique({
      where: { chatId },
      include: { user: { select: userSelect } },
    });

    return row === null ? null : toChatLink(row);
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

    return toChatLink(row);
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
}

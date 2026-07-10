/**
 * Mappers puros del repositorio de Telegram.
 *
 * Responsabilidad: aislar la traducción `fila Prisma` -> modelo de dominio de
 * las entidades de Telegram (vínculos de chat, logs de interacción y usuarios
 * vinculables). Todas las funciones aquí son puras (no dependen de `this` ni
 * del cliente Prisma) para mantener el repositorio enfocado en el acceso a
 * datos.
 *
 * Importante: este módulo NO debe importar del repositorio (evita ciclos).
 */
import type {
  TelegramChatLink,
  TelegramInteractionLog,
  TelegramLinkedUser,
} from '../../../domain/models/Telegram.js';

/**
 * Mapea la proyección de usuario al modelo de dominio
 * {@link TelegramLinkedUser}, exponiendo solo identidad, contacto y rol/estado
 * necesarios para la vinculación.
 *
 * @param row Proyección de usuario devuelta por Prisma.
 * @returns Usuario vinculable de dominio.
 */
export function toLinkedUser(row: {
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

/**
 * Mapea una fila de `telegram_chat_links` (con su usuario opcional incluido)
 * al modelo de dominio {@link TelegramChatLink}.
 *
 * Casos borde: los campos anulables de Telegram (`telegramUserId`,
 * `telegramUsername`, `disabledAt`) solo se incluyen cuando no son `null`; el
 * `status` se castea al tipo de unión del dominio; el usuario asociado solo se
 * proyecta cuando viene cargado en la relación.
 *
 * @param row Fila de Prisma con la relación de usuario opcional.
 * @returns Vínculo de chat de dominio.
 */
export function toChatLink(row: {
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
    ...(row.user !== undefined ? { user: toLinkedUser(row.user) } : {}),
  };
}

/**
 * Mapea una fila de `telegram_interaction_logs` al modelo de dominio
 * {@link TelegramInteractionLog}.
 *
 * Casos borde: todos los campos anulables (incluidos `tenantId`/`userId`, que
 * pueden faltar en interacciones de chats no vinculados, y `metadata` JSON)
 * solo se incluyen cuando no son `null`; el `status` se castea al tipo de
 * unión del dominio.
 *
 * @param row Fila de Prisma del log de interacción.
 * @returns Registro de interacción de dominio.
 */
export function toInteractionLog(row: {
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

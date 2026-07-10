import type { UserRole } from './AuthContext.js';

/**
 * Estado de un vínculo entre un usuario y un chat de Telegram.
 *
 * - `ACTIVE`: Vínculo activo; el bot puede interactuar con el chat.
 * - `DISABLED`: Vínculo deshabilitado.
 */
export type TelegramChatLinkStatus = 'ACTIVE' | 'DISABLED';

/**
 * Resultado del procesamiento de una interacción recibida por Telegram.
 *
 * - `PROCESSED`: La interacción se procesó correctamente.
 * - `IGNORED`: La interacción se ignoró (no relevante o no autorizada).
 * - `ERROR`: Se produjo un error al procesar la interacción.
 */
export type TelegramInteractionStatus = 'PROCESSED' | 'IGNORED' | 'ERROR';

/**
 * Datos del usuario de la plataforma vinculado a un chat de Telegram, embebidos
 * en {@link TelegramChatLink} para evitar lecturas adicionales.
 */
export interface TelegramLinkedUser {
  /** Identificador único del usuario. */
  readonly id: string;
  /** Tenant (cliente) al que pertenece el usuario. */
  readonly tenantId: string;
  /** Correo electrónico del usuario. */
  readonly email: string;
  /** Nombre del usuario. */
  readonly name: string;
  /** Rol del usuario en la plataforma. */
  readonly role: UserRole;
  /** Estado del usuario (activo o deshabilitado). */
  readonly status: 'ACTIVE' | 'DISABLED';
}

/**
 * Vínculo entre un usuario de la plataforma y un chat de Telegram, que permite
 * enviar notificaciones y recibir comandos a través del bot.
 */
export interface TelegramChatLink {
  /** Identificador único del vínculo. */
  readonly id: string;
  /** Tenant (cliente) al que pertenece el vínculo. */
  readonly tenantId: string;
  /** Usuario de la plataforma vinculado. */
  readonly userId: string;
  /** Identificador del chat de Telegram (chat_id). */
  readonly chatId: string;
  /** Identificador del usuario en Telegram (user id), si se conoce. */
  readonly telegramUserId?: string;
  /** Nombre de usuario (@username) en Telegram, si se conoce. */
  readonly telegramUsername?: string;
  /** Estado del vínculo. */
  readonly status: TelegramChatLinkStatus;
  /** Usuario que creó el vínculo. */
  readonly linkedByUserId: string;
  /** Fecha en la que el vínculo fue deshabilitado, si aplica. */
  readonly disabledAt?: Date;
  /** Fecha de creación del registro. */
  readonly createdAt: Date;
  /** Fecha de la última actualización del registro. */
  readonly updatedAt: Date;
  /** Datos del usuario vinculado, embebidos cuando se solicitan. */
  readonly user?: TelegramLinkedUser;
}

/**
 * Registro de auditoría de una interacción recibida por Telegram (comando o
 * mensaje), utilizado para trazabilidad y diagnóstico del bot.
 */
export interface TelegramInteractionLog {
  /** Identificador único del registro. */
  readonly id: string;
  /** Tenant (cliente) asociado, si se pudo resolver. */
  readonly tenantId?: string;
  /** Usuario de la plataforma asociado, si se pudo resolver. */
  readonly userId?: string;
  /** Identificador del chat de Telegram (chat_id) de origen. */
  readonly chatId: string;
  /** Identificador del usuario en Telegram (user id), si se conoce. */
  readonly telegramUserId?: string;
  /** Nombre de usuario (@username) en Telegram, si se conoce. */
  readonly telegramUsername?: string;
  /** Comando recibido, si la interacción fue un comando. */
  readonly command?: string;
  /** Resultado del procesamiento de la interacción. */
  readonly status: TelegramInteractionStatus;
  /** Vista previa del texto recibido (truncada por privacidad/tamaño). */
  readonly textPreview?: string;
  /** Mensaje de error cuando el estado es `ERROR`. */
  readonly errorMessage?: string;
  /** Metadatos adicionales de la interacción (estructura libre). */
  readonly metadata?: unknown;
  /** Fecha de creación del registro. */
  readonly createdAt: Date;
}

import type { TelegramChatLink, TelegramInteractionLog, TelegramInteractionStatus, TelegramLinkedUser } from '../models/Telegram.js';

/**
 * Datos de entrada para crear o actualizar el vínculo entre un chat de Telegram
 * y un usuario del sistema.
 *
 * Permite asociar un `chatId` de Telegram a un usuario de un tenant para enviar
 * notificaciones y procesar comandos.
 */
export interface CreateOrUpdateTelegramLinkInput {
  readonly tenantId: string;
  readonly userId: string;
  /** Identificador del chat de Telegram al que se vincula el usuario. */
  readonly chatId: string;
  /** Identificador numérico del usuario en Telegram; opcional. */
  readonly telegramUserId?: string;
  /** Nombre de usuario (@handle) en Telegram; opcional. */
  readonly telegramUsername?: string;
  /** Usuario que realizó la acción de vinculación; usado para auditoría. */
  readonly linkedByUserId: string;
}

/**
 * Datos de entrada para registrar una interacción ocurrida en Telegram.
 *
 * El tenant y el usuario son opcionales porque la interacción puede provenir de
 * un chat aún no vinculado o no reconocido.
 */
export interface CreateTelegramInteractionLogInput {
  /** Tenant asociado; opcional cuando el chat no está vinculado. */
  readonly tenantId?: string;
  /** Usuario asociado; opcional cuando el chat no está vinculado. */
  readonly userId?: string;
  readonly chatId: string;
  readonly telegramUserId?: string;
  readonly telegramUsername?: string;
  /** Comando recibido (e.g., "/start"); opcional si el mensaje no es un comando. */
  readonly command?: string;
  /** Resultado del procesamiento de la interacción. */
  readonly status: TelegramInteractionStatus;
  /** Vista previa del texto del mensaje; opcional y truncada por privacidad. */
  readonly textPreview?: string;
  /** Mensaje de error si el procesamiento falló; opcional. */
  readonly errorMessage?: string;
  readonly metadata?: unknown;
}

/**
 * Datos de entrada para registrar un evento de auditoría relacionado con Telegram.
 */
export interface CreateTelegramAuditEventInput {
  readonly tenantId: string;
  /** Usuario que ejecuta la acción auditada. */
  readonly actorUserId: string;
  /** Acción realizada (e.g., "LINK_CREATED"). */
  readonly action: string;
  /** Tipo de entidad afectada. */
  readonly entityType: string;
  /** Identificador de la entidad afectada; opcional. */
  readonly entityId?: string;
  readonly metadata?: unknown;
}

/**
 * Contrato de repositorio para la integración con Telegram.
 *
 * Puerto de dominio (DIP) cuya implementación concreta reside en la capa de
 * infraestructura. Administra los vínculos chat–usuario, el registro de
 * interacciones y los eventos de auditoría de la integración.
 */
export interface ITelegramRepository {
  /**
   * Busca un usuario por correo dentro de un tenant, para vincularlo a Telegram.
   *
   * @param tenantId - Tenant en el que se busca.
   * @param email    - Correo electrónico del usuario.
   * @returns El usuario vinculable si existe; `null` si no hay coincidencia en el tenant.
   */
  findUserByEmailInTenant(tenantId: string, email: string): Promise<TelegramLinkedUser | null>;

  /**
   * Lista todos los vínculos de Telegram de un tenant.
   *
   * @param tenantId - Tenant cuyos vínculos se listan.
   * @returns Vínculos del tenant (posiblemente vacío).
   */
  findLinksByTenant(tenantId: string): Promise<TelegramChatLink[]>;

  /**
   * Busca un vínculo de Telegram por su identificador dentro de un tenant.
   *
   * @param tenantId - Tenant propietario del vínculo.
   * @param id       - Identificador del vínculo.
   * @returns El vínculo si existe; `null` si no se encuentra.
   */
  findLinkById(tenantId: string, id: string): Promise<TelegramChatLink | null>;

  /**
   * Busca un vínculo activo asociado a un chat de Telegram.
   *
   * @param chatId - Identificador del chat de Telegram.
   * @returns El vínculo activo si existe; `null` si no hay vínculo activo para ese chat.
   */
  findActiveLinkByChatId(chatId: string): Promise<TelegramChatLink | null>;

  /**
   * Busca cualquier vínculo asociado a un chat de Telegram, esté activo o no.
   *
   * @param chatId - Identificador del chat de Telegram.
   * @returns El vínculo si existe (activo o deshabilitado); `null` si no hay ninguno.
   */
  findAnyLinkByChatId(chatId: string): Promise<TelegramChatLink | null>;

  /**
   * Crea o actualiza el vínculo entre un chat de Telegram y un usuario.
   *
   * @param input - Datos del vínculo a crear o actualizar.
   * @returns El vínculo resultante.
   */
  createOrUpdateLink(input: CreateOrUpdateTelegramLinkInput): Promise<TelegramChatLink>;

  /**
   * Deshabilita un vínculo de Telegram.
   *
   * @param tenantId - Tenant propietario del vínculo.
   * @param id       - Identificador del vínculo a deshabilitar.
   * @returns El vínculo deshabilitado; `null` si no existe.
   */
  disableLink(tenantId: string, id: string): Promise<TelegramChatLink | null>;

  /**
   * Registra una interacción ocurrida en Telegram.
   *
   * @param input - Datos de la interacción a registrar.
   * @returns El registro de interacción creado.
   */
  createInteractionLog(input: CreateTelegramInteractionLogInput): Promise<TelegramInteractionLog>;

  /**
   * Registra un evento de auditoría de la integración con Telegram.
   *
   * @param input - Datos del evento de auditoría.
   */
  createAuditEvent(input: CreateTelegramAuditEventInput): Promise<void>;
}

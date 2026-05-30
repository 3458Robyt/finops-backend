import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { ITelegramRepository } from '../../domain/interfaces/ITelegramRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { TelegramChatLink } from '../../domain/models/Telegram.js';
import type { ITelegramClient } from './TelegramClient.js';

/** Datos de entrada para crear (o actualizar) la vinculación de un chat de Telegram con un usuario. */
export interface CreateTelegramLinkInput {
  /** Email del usuario FinOps a vincular (se normaliza a minúsculas). */
  readonly email: string;
  /** Identificador del chat de Telegram a vincular. */
  readonly chatId: string;
  /** Identificador numérico del usuario de Telegram (opcional). */
  readonly telegramUserId?: string;
  /** Nombre de usuario de Telegram, sin la `@` inicial (opcional). */
  readonly telegramUsername?: string;
}

/** Roles autorizados a administrar las vinculaciones de Telegram. */
const adminRoles = new Set<AuthContext['role']>(['ADMIN', 'OPERATOR_ADMIN']);

/**
 * Servicio de aplicación que gestiona el ciclo de vida de las vinculaciones
 * ("links") entre chats de Telegram y usuarios FinOps de un tenant. Cubre el
 * listado, creación, deshabilitación y envío de mensajes de prueba, aplicando
 * control de acceso por rol y registrando eventos de auditoría.
 *
 * Colaboradores inyectados:
 * - {@link ITelegramRepository}: persistencia de vínculos, usuarios y eventos de auditoría.
 * - {@link ITelegramClient}: envío de mensajes de prueba a Telegram.
 *
 * Rol dentro del flujo: punto de administración del canal Telegram; todas las
 * operaciones requieren rol administrativo.
 */
export class TelegramLinkService {
  constructor(
    private readonly repository: ITelegramRepository,
    private readonly telegramClient: ITelegramClient,
  ) {}

  /**
   * Lista las vinculaciones de Telegram del tenant del actor.
   *
   * @param actor - Contexto de autenticación del solicitante.
   * @returns Las vinculaciones de Telegram del tenant.
   * @throws {AuthorizationError} Si el actor no tiene rol administrativo.
   */
  public async listLinks(actor: AuthContext): Promise<TelegramChatLink[]> {
    this.requireAdmin(actor);
    return this.repository.findLinksByTenant(actor.tenantId);
  }

  /**
   * Crea o actualiza la vinculación de un chat de Telegram con un usuario del
   * tenant.
   *
   * Normaliza email y chatId, valida que el usuario exista y esté activo en el
   * tenant, y evita reasignar un chat que ya está vinculado activamente a otro
   * usuario o tenant. El nombre de usuario de Telegram se almacena sin la `@`.
   *
   * Efectos secundarios: persiste/actualiza el vínculo y registra un evento de
   * auditoría `TELEGRAM_LINK_CREATED`.
   *
   * @param actor - Contexto de autenticación del solicitante (debe ser admin).
   * @param input - Datos de la vinculación a crear.
   * @returns El vínculo creado o actualizado.
   * @throws {AuthorizationError} Si el actor no tiene rol administrativo.
   * @throws {FinOpsBaseError} VALIDATION_ERROR si faltan email o chatId.
   * @throws {FinOpsBaseError} NOT_FOUND si el usuario no existe en el tenant o está inactivo.
   * @throws {FinOpsBaseError} CONFLICT si el chat ya está vinculado activamente a otro usuario/tenant.
   */
  public async createLink(actor: AuthContext, input: CreateTelegramLinkInput): Promise<TelegramChatLink> {
    this.requireAdmin(actor);

    const email = input.email.trim().toLowerCase();
    const chatId = input.chatId.trim();

    if (email === '' || chatId === '') {
      throw new FinOpsBaseError('Email and chatId are required', 'VALIDATION_ERROR');
    }

    const user = await this.repository.findUserByEmailInTenant(actor.tenantId, email);

    if (user === null || user.status !== 'ACTIVE') {
      throw new FinOpsBaseError('User not found in current tenant or inactive', 'NOT_FOUND');
    }

    const existing = await this.repository.findAnyLinkByChatId(chatId);

    if (
      existing !== null &&
      existing.status === 'ACTIVE' &&
      (existing.tenantId !== actor.tenantId || existing.userId !== user.id)
    ) {
      throw new FinOpsBaseError('Telegram chat is already linked to another user or tenant', 'CONFLICT');
    }

    const link = await this.repository.createOrUpdateLink({
      tenantId: actor.tenantId,
      userId: user.id,
      chatId,
      ...(input.telegramUserId !== undefined && input.telegramUserId.trim() !== ''
        ? { telegramUserId: input.telegramUserId.trim() }
        : {}),
      ...(input.telegramUsername !== undefined && input.telegramUsername.trim() !== ''
        ? { telegramUsername: input.telegramUsername.trim().replace(/^@/, '') }
        : {}),
      linkedByUserId: actor.userId,
    });

    await this.repository.createAuditEvent({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'TELEGRAM_LINK_CREATED',
      entityType: 'TelegramChatLink',
      entityId: link.id,
      metadata: {
        chatId: link.chatId,
        userId: link.userId,
        email: user.email,
      },
    });

    return link;
  }

  /**
   * Deshabilita una vinculación de Telegram existente del tenant.
   *
   * Efectos secundarios: marca el vínculo como deshabilitado y registra un
   * evento de auditoría `TELEGRAM_LINK_DISABLED`.
   *
   * @param actor - Contexto de autenticación del solicitante (debe ser admin).
   * @param linkId - Identificador del vínculo a deshabilitar.
   * @returns El vínculo deshabilitado.
   * @throws {AuthorizationError} Si el actor no tiene rol administrativo.
   * @throws {FinOpsBaseError} NOT_FOUND si el vínculo no existe.
   */
  public async disableLink(actor: AuthContext, linkId: string): Promise<TelegramChatLink> {
    this.requireAdmin(actor);

    const link = await this.repository.disableLink(actor.tenantId, linkId);

    if (link === null) {
      throw new FinOpsBaseError('Telegram link not found', 'NOT_FOUND');
    }

    await this.repository.createAuditEvent({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'TELEGRAM_LINK_DISABLED',
      entityType: 'TelegramChatLink',
      entityId: link.id,
      metadata: {
        chatId: link.chatId,
        userId: link.userId,
      },
    });

    return link;
  }

  /**
   * Envía un mensaje de prueba a un chat vinculado para verificar la integración.
   *
   * Comprueba que el vínculo exista y esté activo antes de enviar un mensaje de
   * confirmación que invita a usar /ayuda.
   *
   * Efectos secundarios: envía un mensaje vía Telegram y registra un evento de
   * auditoría `TELEGRAM_TEST_MESSAGE_SENT`.
   *
   * @param actor - Contexto de autenticación del solicitante (debe ser admin).
   * @param linkId - Identificador del vínculo destino.
   * @returns El vínculo al que se envió el mensaje de prueba.
   * @throws {AuthorizationError} Si el actor no tiene rol administrativo.
   * @throws {FinOpsBaseError} NOT_FOUND si el vínculo no existe.
   * @throws {FinOpsBaseError} VALIDATION_ERROR si el vínculo está deshabilitado.
   */
  public async sendTestMessage(actor: AuthContext, linkId: string): Promise<TelegramChatLink> {
    this.requireAdmin(actor);

    const link = await this.repository.findLinkById(actor.tenantId, linkId);

    if (link === null) {
      throw new FinOpsBaseError('Telegram link not found', 'NOT_FOUND');
    }

    if (link.status !== 'ACTIVE') {
      throw new FinOpsBaseError('Telegram link is disabled', 'VALIDATION_ERROR');
    }

    await this.telegramClient.sendMessage({
      chatId: link.chatId,
      text: [
        'Vinculacion Telegram activa.',
        `Usuario FinOps: ${link.user?.email ?? link.userId}`,
        'Ya puedes usar /ayuda para ver comandos disponibles.',
      ].join('\n'),
    });

    await this.repository.createAuditEvent({
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      action: 'TELEGRAM_TEST_MESSAGE_SENT',
      entityType: 'TelegramChatLink',
      entityId: link.id,
      metadata: {
        chatId: link.chatId,
        userId: link.userId,
      },
    });

    return link;
  }

  /**
   * Guarda de autorización: exige que el actor tenga rol administrativo
   * (ADMIN u OPERATOR_ADMIN) para operar sobre las vinculaciones.
   *
   * @throws {AuthorizationError} Si el rol del actor no está autorizado.
   */
  private requireAdmin(actor: AuthContext): void {
    if (!adminRoles.has(actor.role)) {
      throw new AuthorizationError();
    }
  }
}

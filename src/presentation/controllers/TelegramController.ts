import type { Request, Response } from 'express';
import { z } from 'zod';
import type { TelegramBotService } from '../../application/services/TelegramBotService.js';
import type { TelegramLinkService } from '../../application/services/TelegramLinkService.js';
import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';

const createLinkSchema = z.object({
  email: z.string().email(),
  chatId: z.string().min(1),
  telegramUserId: z.string().optional(),
  telegramUsername: z.string().optional(),
});

/**
 * Controlador de la capa de presentación para la integración con Telegram
 * (montado en `/api/v1/telegram`). Traduce las peticiones HTTP hacia los
 * servicios de bot y de vínculos de Telegram y serializa la respuesta.
 *
 * Gestiona el webhook entrante de Telegram y la administración de vínculos
 * (listar, crear, desactivar y enviar mensaje de prueba).
 *
 * Servicios y configuración que utiliza:
 * - {@link TelegramBotService}: procesa las actualizaciones (updates) del webhook.
 * - {@link TelegramLinkService}: gestiona los vínculos entre usuarios y chats de Telegram.
 * - `webhookSecret`: secreto esperado en la cabecera del webhook para autenticar a Telegram.
 * - `enabled`: indica si la integración con Telegram está habilitada.
 *
 * El webhook se autentica por secreto de cabecera (no por sesión); el resto de
 * endpoints requieren autenticación de usuario.
 */
export class TelegramController {
  constructor(
    private readonly botService: TelegramBotService,
    private readonly linkService: TelegramLinkService,
    private readonly webhookSecret: string | undefined,
    private readonly enabled: boolean,
  ) {}

  /**
   * Recibe y procesa una actualización (update) entrante del webhook de Telegram.
   *
   * Sirve: POST /api/v1/telegram/webhook
   * Autenticación: por secreto de cabecera (no usa `req.auth`). Telegram debe
   * enviar el secreto en la cabecera `X-Telegram-Bot-Api-Secret-Token`.
   *
   * Cuerpo (`req.body`): el objeto update de Telegram, delegado a {@link TelegramBotService}.
   *
   * Respuestas:
   * - 200: `{ success: true }` si la actualización se procesa correctamente.
   * - 503 TELEGRAM_DISABLED: la integración está deshabilitada (`enabled` false).
   * - 503 CONFIGURATION_ERROR: el secreto del webhook no está configurado.
   * - 401 AUTHENTICATION_FAILED: el secreto de la cabecera no coincide.
   * - 400 / 404 / 409 / 500: errores de dominio (ver {@link handleError}).
   */
  public webhook = async (req: Request, res: Response): Promise<void> => {
    if (!this.enabled) {
      res.status(503).json({ success: false, error: 'Telegram integration is disabled', code: 'TELEGRAM_DISABLED' });
      return;
    }

    if (this.webhookSecret === undefined || this.webhookSecret.trim() === '') {
      res.status(503).json({ success: false, error: 'Telegram webhook secret is not configured', code: 'CONFIGURATION_ERROR' });
      return;
    }

    if (req.header('X-Telegram-Bot-Api-Secret-Token') !== this.webhookSecret) {
      res.status(401).json({ success: false, error: 'Invalid Telegram webhook secret', code: 'AUTHENTICATION_FAILED' });
      return;
    }

    try {
      await this.botService.handleUpdate(req.body);
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible procesar el webhook de Telegram');
    }
  };

  /**
   * Lista los vínculos de Telegram accesibles para el usuario autenticado.
   *
   * Sirve: GET /api/v1/telegram/links
   * Autenticación: requerida. Pasa el contexto `req.auth` al servicio de vínculos.
   *
   * Respuestas:
   * - 200: `{ success: true, links }`.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403 / 400 / 404 / 409 / 500: errores de dominio (ver {@link handleError}).
   */
  public listLinks = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    try {
      const links = await this.linkService.listLinks(req.auth);
      res.status(200).json({ success: true, links });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible cargar vinculos Telegram');
    }
  };

  /**
   * Crea un nuevo vínculo entre un usuario y un chat de Telegram.
   *
   * Sirve: POST /api/v1/telegram/links
   * Autenticación: requerida. Pasa el contexto `req.auth` al servicio de vínculos.
   *
   * Cuerpo (`req.body`, validado con `createLinkSchema`):
   * - `email` (obligatorio): correo electrónico del usuario a vincular.
   * - `chatId` (obligatorio): identificador del chat de Telegram.
   * - `telegramUserId` (opcional): identificador del usuario de Telegram.
   * - `telegramUsername` (opcional): nombre de usuario de Telegram.
   *
   * Respuestas:
   * - 201: `{ success: true, link }` con el vínculo creado.
   * - 400 VALIDATION_ERROR: el cuerpo no cumple el esquema.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403 / 404 / 409 / 500: errores de dominio (ver {@link handleError}).
   */
  public createLink = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const parsed = createLinkSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid Telegram link payload', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const link = await this.linkService.createLink(req.auth, {
        email: parsed.data.email,
        chatId: parsed.data.chatId,
        ...(parsed.data.telegramUserId !== undefined ? { telegramUserId: parsed.data.telegramUserId } : {}),
        ...(parsed.data.telegramUsername !== undefined ? { telegramUsername: parsed.data.telegramUsername } : {}),
      });
      res.status(201).json({ success: true, link });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible crear el vinculo Telegram');
    }
  };

  /**
   * Desactiva un vínculo de Telegram identificado por su id.
   *
   * Sirve: PATCH /api/v1/telegram/links/:id/disable
   * Autenticación: requerida. Pasa el contexto `req.auth` al servicio de vínculos.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador del vínculo a desactivar.
   *
   * Respuestas:
   * - 200: `{ success: true, link }` con el vínculo desactivado.
   * - 400 VALIDATION_ERROR: falta el `id` del vínculo.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403 / 404 / 409 / 500: errores de dominio (ver {@link handleError}).
   */
  public disableLink = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const linkId = this.parseId(req);

    if (linkId === undefined) {
      res.status(400).json({ success: false, error: 'Telegram link id is required', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const link = await this.linkService.disableLink(req.auth, linkId);
      res.status(200).json({ success: true, link });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible desactivar el vinculo Telegram');
    }
  };

  /**
   * Envía un mensaje de prueba al chat asociado a un vínculo de Telegram.
   *
   * Sirve: POST /api/v1/telegram/links/:id/test-message
   * Autenticación: requerida. Pasa el contexto `req.auth` al servicio de vínculos.
   *
   * Parámetros de ruta:
   * - `id` (`req.params.id`): identificador del vínculo destino del mensaje.
   *
   * Respuestas:
   * - 200: `{ success: true, link }`.
   * - 400 VALIDATION_ERROR: falta el `id` del vínculo.
   * - 401 AUTHENTICATION_REQUIRED: sin sesión autenticada.
   * - 403 / 404 / 409 / 500: errores de dominio (ver {@link handleError}).
   */
  public sendTestMessage = async (req: Request, res: Response): Promise<void> => {
    if (req.auth === undefined) {
      res.status(401).json({ success: false, error: 'Authentication is required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }

    const linkId = this.parseId(req);

    if (linkId === undefined) {
      res.status(400).json({ success: false, error: 'Telegram link id is required', code: 'VALIDATION_ERROR' });
      return;
    }

    try {
      const link = await this.linkService.sendTestMessage(req.auth, linkId);
      res.status(200).json({ success: true, link });
    } catch (error: unknown) {
      this.handleError(error, res, 'No fue posible enviar mensaje de prueba');
    }
  };

  /**
   * Lee el parámetro de ruta `id` (`req.params.id`) recortado. Devuelve la
   * cadena no vacía o `undefined` si está ausente o vacía.
   */
  private parseId(req: Request): string | undefined {
    const id = req.params['id'];
    return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
  }

  /**
   * Manejador centralizado de errores que traduce excepciones de dominio a
   * códigos de estado HTTP:
   * - {@link AuthorizationError} -> 403.
   * - {@link FinOpsBaseError} con código `VALIDATION_ERROR` -> 400; `NOT_FOUND`
   *   -> 404; `CONFLICT` -> 409; cualquier otro código -> 500.
   * - Error no controlado -> 500 con `fallbackMessage`.
   */
  private handleError(error: unknown, res: Response, fallbackMessage: string): void {
    if (error instanceof AuthorizationError) {
      res.status(403).json({ success: false, error: error.message, code: error.code });
      return;
    }

    if (error instanceof FinOpsBaseError) {
      const status = error.code === 'VALIDATION_ERROR'
        ? 400
        : error.code === 'NOT_FOUND'
          ? 404
          : error.code === 'CONFLICT'
            ? 409
            : 500;

      res.status(status).json({ success: false, error: error.message, code: error.code });
      return;
    }

    res.status(500).json({ success: false, error: fallbackMessage });
  }
}

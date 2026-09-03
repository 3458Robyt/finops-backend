import { ConfigurationError, FinOpsBaseError } from '../../domain/errors/errors.js';

/** Datos necesarios para enviar un mensaje a un chat de Telegram. */
export interface TelegramSendMessageInput {
  /** Identificador del chat destino de Telegram. */
  readonly chatId: string;
  /** Texto del mensaje a enviar. */
  readonly text: string;
}

/**
 * Puerto (interfaz) del cliente de Telegram. Abstrae el envío de mensajes para
 * permitir implementaciones reales o de prueba (stubs) sin acoplar la lógica de
 * aplicación a la API HTTP de Telegram.
 */
export interface ITelegramClient {
  sendMessage(input: TelegramSendMessageInput): Promise<void>;
  verify?(): Promise<void>;
}

/**
 * Adaptador de salida que implementa {@link ITelegramClient} contra la API HTTP
 * de Telegram Bot. Su responsabilidad es enviar mensajes al endpoint
 * `sendMessage` de Telegram cuando la integración está habilitada.
 *
 * Parámetros de configuración inyectados:
 * - `botToken`: token del bot de Telegram (requerido si está habilitado).
 * - `enabled`: bandera que activa o desactiva el envío real.
 *
 * Rol dentro del flujo: capa de infraestructura del canal Telegram, usada por
 * los servicios de aplicación para entregar respuestas al usuario.
 */
export class TelegramClient implements ITelegramClient {
  constructor(
    private readonly botToken: string | undefined,
    private readonly enabled: boolean,
    private readonly timeoutMs = 15_000,
  ) {}

  /**
   * Envía un mensaje a un chat de Telegram mediante la API HTTP del bot.
   *
   * Si la integración está deshabilitada (`enabled === false`) la operación es
   * un no-op silencioso. En caso contrario realiza una petición POST al endpoint
   * `sendMessage` de Telegram con la vista previa de enlaces desactivada.
   *
   * Efecto secundario: realiza una llamada HTTP saliente a la API de Telegram.
   *
   * @param input - Chat destino y texto del mensaje.
   * @returns Promesa que se resuelve cuando el envío termina (o se omite si está deshabilitado).
   * @throws {ConfigurationError} Si la integración está habilitada pero falta el token del bot.
   * @throws {FinOpsBaseError} Si la API de Telegram responde con un estado no exitoso.
   */
  public async sendMessage(input: TelegramSendMessageInput): Promise<void> {
    if (!this.enabled) {
      return;
    }

    if (this.botToken === undefined || this.botToken.trim() === '') {
      throw new ConfigurationError('TELEGRAM_BOT_TOKEN is required when Telegram is enabled');
    }

    if (input.text.trim() === '') {
      throw new FinOpsBaseError('Telegram message cannot be empty', 'TELEGRAM_INVALID_MESSAGE');
    }
    if (input.text.length > 4096) {
      throw new FinOpsBaseError('Telegram message exceeds the provider limit', 'TELEGRAM_MESSAGE_TOO_LONG');
    }

    const response = await this.request('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      disable_web_page_preview: true,
    });
    if (!response.ok) {
      throw new FinOpsBaseError(
        `Telegram sendMessage failed with status ${response.status}`,
        response.status === 429 ? 'TELEGRAM_RATE_LIMITED' : 'TELEGRAM_SEND_FAILED',
        response.retryAfter === undefined ? undefined : { retryAfterSeconds: response.retryAfter },
      );
    }
  }

  /** Valida el token y la identidad del bot sin enviar mensajes. */
  public async verify(): Promise<void> {
    if (!this.enabled) throw new FinOpsBaseError('Telegram channel is disabled', 'TELEGRAM_DISABLED');
    const response = await this.request('getMe', {});
    if (!response.ok) {
      throw new FinOpsBaseError(`Telegram getMe failed with status ${response.status}`, 'TELEGRAM_VERIFY_FAILED');
    }
  }

  private async request(method: string, body: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly status: number; readonly retryAfter?: number }> {
    if (this.botToken === undefined || this.botToken.trim() === '') {
      throw new ConfigurationError('TELEGRAM_BOT_TOKEN is required when Telegram is enabled');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`https://api.telegram.org/bot${this.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new FinOpsBaseError('Telegram provider request timed out', 'TELEGRAM_TIMEOUT');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const parameters = record['parameters'] !== null && typeof record['parameters'] === 'object'
      ? record['parameters'] as Record<string, unknown>
      : {};
    return {
      ok: response.ok && record['ok'] === true,
      status: response.status,
      ...(typeof parameters['retry_after'] === 'number' ? { retryAfter: parameters['retry_after'] } : {}),
    };
  }
}

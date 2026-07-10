/**
 * ═══════════════════════════════════════════════════════════════
 * Parser de updates entrantes de Telegram
 * ═══════════════════════════════════════════════════════════════
 *
 * Funciones puras y tipos que extraen y validan la información mínima de un
 * "update" de la API de Telegram (mensaje, chat, usuario) e interpretan el
 * texto como comando o texto libre. Aísla el parseo del orquestador del bot y
 * no importa del servicio, evitando dependencias circulares.
 *
 * @module application/services/telegram/telegramUpdateParser
 */

/**
 * Forma (parcial) de un "update" entrante de la API de Telegram. Todos los
 * campos son opcionales porque Telegram puede enviar tipos de update que este
 * bot no procesa (p. ej. ediciones, callbacks); el parseo valida lo necesario.
 */
export interface TelegramUpdate {
  readonly update_id?: number;
  readonly message?: {
    readonly message_id?: number;
    readonly text?: string;
    readonly chat?: {
      readonly id?: number | string;
      readonly type?: string;
    };
    readonly from?: {
      readonly id?: number | string;
      readonly username?: string;
      readonly first_name?: string;
      readonly last_name?: string;
    };
  };
}

/** Mensaje de Telegram ya parseado y validado a la forma mínima que usa el servicio. */
export interface ParsedTelegramMessage {
  readonly chatId: string;
  readonly telegramUserId?: string;
  readonly telegramUsername?: string;
  readonly text: string;
}

/** Comando interpretado a partir del texto del mensaje, con su argumento asociado. */
export interface ParsedCommand {
  /** Comando detectado (p. ej. `/chat`) o `TEXT` para texto libre sin comando. */
  readonly command: string;
  /** Resto del texto tras el comando, usado como argumento. */
  readonly argument: string;
}

/**
 * Extrae y valida la información mínima de un update de Telegram.
 *
 * Solo acepta updates con un chat id (numérico o string) y un texto no vacío;
 * en otro caso devuelve `null` para que el llamador lo trate como no soportado.
 * Normaliza el chatId a string y arrastra el usuario de Telegram cuando existe.
 *
 * @param update - Update crudo de Telegram.
 * @returns El mensaje parseado, o `null` si el update no es procesable.
 */
export function parseMessage(update: TelegramUpdate): ParsedTelegramMessage | null {
  const chatId = update.message?.chat?.id;
  const text = update.message?.text;

  if ((typeof chatId !== 'number' && typeof chatId !== 'string') || typeof text !== 'string' || text.trim() === '') {
    return null;
  }

  const from = update.message?.from;

  return {
    chatId: String(chatId),
    ...(from?.id !== undefined ? { telegramUserId: String(from.id) } : {}),
    ...(from?.username !== undefined ? { telegramUsername: from.username } : {}),
    text: text.trim(),
  };
}

/**
 * Interpreta el texto del mensaje como comando o como texto libre.
 *
 * Si no empieza por `/` se trata como `TEXT` con el texto íntegro como
 * argumento. En caso contrario separa el comando del resto, descarta el
 * sufijo `@nombrebot` (que Telegram añade en grupos) y normaliza a minúsculas.
 *
 * @param text - Texto del mensaje ya recortado.
 * @returns El comando y su argumento.
 */
export function parseCommand(text: string): ParsedCommand {
  if (!text.startsWith('/')) {
    return { command: 'TEXT', argument: text };
  }

  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = (rawCommand ?? '').split('@')[0]?.toLowerCase() ?? '';

  return {
    command,
    argument: rest.join(' ').trim(),
  };
}

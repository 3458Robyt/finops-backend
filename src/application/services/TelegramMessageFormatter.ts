/** Límite máximo de caracteres por mensaje aplicado al fragmentar (algo por debajo del límite real de Telegram, ~4096). */
const telegramMessageLimit = 3900;

/**
 * Servicio de aplicación responsable de formatear y fragmentar los mensajes que
 * el bot envía por Telegram. Centraliza los textos de ayuda y de chats no
 * vinculados, y divide mensajes largos en fragmentos que respetan el límite de
 * longitud de Telegram.
 *
 * No tiene colaboradores inyectados; es un componente puro de presentación.
 *
 * Rol dentro del flujo: capa de formateo del canal Telegram, usada por
 * {@link TelegramBotService} para componer las respuestas al usuario.
 */
export class TelegramMessageFormatter {
  /**
   * Divide un texto en fragmentos que no superen el límite de longitud de
   * Telegram.
   *
   * Si el texto cabe en un único mensaje se devuelve tal cual (normalizado con
   * trim). En caso contrario se trocea iterativamente buscando un punto de corte
   * adecuado (preferiblemente en un salto de línea) para no partir el contenido
   * de forma abrupta.
   *
   * @param text - Texto a fragmentar.
   * @returns Lista de fragmentos listos para enviarse como mensajes separados.
   */
  public split(text: string): string[] {
    const normalized = text.trim();

    if (normalized.length <= telegramMessageLimit) {
      return [normalized];
    }

    const chunks: string[] = [];
    let remaining = normalized;

    while (remaining.length > telegramMessageLimit) {
      const splitAt = this.findSplitIndex(remaining);
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
  }

  /**
   * Construye el mensaje de ayuda con la lista de comandos disponibles del bot.
   *
   * @param botUsername - Nombre de usuario del bot (con o sin `@`); si no se
   *   proporciona se usa el texto genérico "el bot".
   * @returns El texto de ayuda formateado.
   */
  public helpMessage(botUsername?: string): string {
    const botHint = botUsername !== undefined && botUsername.trim() !== ''
      ? `@${botUsername.replace(/^@/, '')}`
      : 'el bot';

    return [
      `Comandos disponibles en ${botHint}:`,
      '',
      '/chat <pregunta> - Pregunta al asistente FinOps.',
      '/recordatorios - Ver ahorro no capturado y recomendaciones pendientes.',
      '/recomendaciones - Listar recomendaciones activas.',
      '/costos - Ver resumen de costos actual.',
      '/oportunidades - Ver oportunidades detectadas.',
      '/ayuda - Mostrar esta ayuda.',
      '',
      'Tambien puedes escribir una pregunta directamente y la tratare como chat.',
    ].join('\n');
  }

  /**
   * Mensaje de bienvenida (comando /start) para un chat aún no vinculado.
   * Incluye el Chat ID para que el usuario pueda compartirlo con un administrador.
   *
   * @param chatId - Identificador del chat de Telegram a mostrar.
   * @returns El texto de bienvenida para chats no vinculados.
   */
  public unlinkedStartMessage(chatId: string): string {
    return [
      'Tu chat de Telegram aun no esta vinculado a FinOps TAK.',
      '',
      `Chat ID: ${chatId}`,
      '',
      'Envia este Chat ID a un administrador para que lo registre en la seccion Agente IA > Telegram.',
    ].join('\n');
  }

  /**
   * Mensaje para cualquier interacción de un chat no vinculado distinta de
   * /start. Recuerda que no se pueden mostrar datos FinOps e incluye el Chat ID.
   *
   * @param chatId - Identificador del chat de Telegram a mostrar.
   * @returns El texto informativo para chats no vinculados.
   */
  public unlinkedMessage(chatId: string): string {
    return [
      'No puedo mostrar datos FinOps porque este chat no esta vinculado.',
      `Chat ID: ${chatId}`,
      'Pide a un administrador que lo registre en la aplicacion.',
    ].join('\n');
  }

  /**
   * Determina el índice de corte para fragmentar un texto largo.
   *
   * Prefiere cortar en el último salto de línea anterior al límite para no
   * partir frases, pero solo si dicho salto está suficientemente avanzado
   * (> 1000 caracteres); de lo contrario corta directamente en el límite para
   * evitar fragmentos demasiado pequeños.
   */
  private findSplitIndex(value: string): number {
    const candidate = value.lastIndexOf('\n', telegramMessageLimit);

    if (candidate > 1000) {
      return candidate;
    }

    return telegramMessageLimit;
  }
}

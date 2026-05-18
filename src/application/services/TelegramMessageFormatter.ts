const telegramMessageLimit = 3900;

export class TelegramMessageFormatter {
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

  public unlinkedStartMessage(chatId: string): string {
    return [
      'Tu chat de Telegram aun no esta vinculado a FinOps TAK.',
      '',
      `Chat ID: ${chatId}`,
      '',
      'Envia este Chat ID a un administrador para que lo registre en la seccion Agente IA > Telegram.',
    ].join('\n');
  }

  public unlinkedMessage(chatId: string): string {
    return [
      'No puedo mostrar datos FinOps porque este chat no esta vinculado.',
      `Chat ID: ${chatId}`,
      'Pide a un administrador que lo registre en la aplicacion.',
    ].join('\n');
  }

  private findSplitIndex(value: string): number {
    const candidate = value.lastIndexOf('\n', telegramMessageLimit);

    if (candidate > 1000) {
      return candidate;
    }

    return telegramMessageLimit;
  }
}

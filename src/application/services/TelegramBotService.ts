import type { FinOpsAiService } from './FinOpsAiService.js';
import type { TelegramMessageFormatter } from './TelegramMessageFormatter.js';
import type { ITelegramClient } from './TelegramClient.js';
import type { SavingsReminderService } from './SavingsReminderService.js';
import type { ICostAnalyticsRepository } from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { ITelegramRepository } from '../../domain/interfaces/ITelegramRepository.js';
import type { TelegramChatLink } from '../../domain/models/Telegram.js';
import {
  parseCommand,
  parseMessage,
  type ParsedCommand,
  type ParsedTelegramMessage,
  type TelegramUpdate,
} from './telegram/telegramUpdateParser.js';
import {
  formatCosts as renderCosts,
  formatOpportunities as renderOpportunities,
  formatRecommendations as renderRecommendations,
  formatSavingsReminders as renderSavingsReminders,
  truncatePreview,
} from './telegram/telegramMessageFormatters.js';

// Reexporta el tipo público del update para preservar la API del módulo.
export type { TelegramUpdate } from './telegram/telegramUpdateParser.js';

/**
 * Servicio de aplicación que implementa la lógica del bot de Telegram FinOps.
 * Recibe los updates entrantes, valida la vinculación del chat, interpreta los
 * comandos y compone las respuestas combinando IA, recordatorios de ahorro,
 * recomendaciones y analítica de costos. También registra cada interacción.
 *
 * El parseo de updates vive en {@link ./telegram/telegramUpdateParser} y el
 * formateo de respuestas en {@link ./telegram/telegramMessageFormatters}; este
 * servicio orquesta la obtención de datos y delega la presentación en ellos.
 *
 * Colaboradores inyectados:
 * - {@link ITelegramRepository}: vínculos de chat y logs de interacción.
 * - {@link ITelegramClient}: envío de mensajes a Telegram.
 * - {@link TelegramMessageFormatter}: formateo y fragmentación de respuestas.
 * - {@link FinOpsAiService}: respuestas conversacionales del asistente.
 * - {@link SavingsReminderService}: recordatorios de ahorro no capturado.
 * - {@link IRecommendationRepository}: recomendaciones activas del tenant.
 * - {@link ICostAnalyticsRepository}: snapshot de costos y oportunidades.
 * - `botUsername` (opcional): nombre del bot para los mensajes de ayuda.
 *
 * Rol dentro del flujo: orquestador del canal Telegram; traduce comandos de
 * usuario en consultas a los servicios FinOps y devuelve respuestas en español.
 */
export class TelegramBotService {
  constructor(
    private readonly repository: ITelegramRepository,
    private readonly telegramClient: ITelegramClient,
    private readonly formatter: TelegramMessageFormatter,
    private readonly aiService: FinOpsAiService,
    private readonly savingsReminderService: SavingsReminderService,
    private readonly recommendationRepository: IRecommendationRepository,
    private readonly analyticsRepository: ICostAnalyticsRepository,
    private readonly botUsername?: string,
  ) {}

  /**
   * Punto de entrada que procesa un update entrante de Telegram de principio a fin.
   *
   * Parsea el mensaje; si no es soportado registra un log IGNORED y termina. Si
   * el chat no está vinculado (o el usuario está deshabilitado) responde con el
   * mensaje correspondiente. En caso contrario interpreta el comando, construye
   * la respuesta, la envía fragmentada y registra la interacción como PROCESSED.
   * Cualquier error se captura: se notifica al usuario y se registra como ERROR.
   *
   * Efectos secundarios: envía mensajes por Telegram y persiste logs de interacción.
   *
   * @param update - Update crudo recibido del webhook/polling de Telegram.
   * @returns Promesa que se resuelve cuando el update ha sido atendido.
   */
  public async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = parseMessage(update);

    if (message === null) {
      await this.repository.createInteractionLog({
        chatId: 'unknown',
        status: 'IGNORED',
        metadata: { reason: 'unsupported_update', updateId: update.update_id },
      });
      return;
    }

    const parsed = parseCommand(message.text);

    try {
      const link = await this.repository.findActiveLinkByChatId(message.chatId);

      if (link === null || link.user?.status === 'DISABLED') {
        await this.handleUnlinkedMessage(message, parsed);
        return;
      }

      const reply = await this.buildLinkedReply(link, parsed, message.text);
      await this.sendChunks(message.chatId, reply);
      await this.logMessage(message, link, parsed.command, 'PROCESSED');
    } catch (error: unknown) {
      await this.sendChunks(message.chatId, 'No pude procesar la solicitud en este momento. Intenta de nuevo mas tarde.');
      await this.logMessage(
        message,
        undefined,
        parsed.command,
        'ERROR',
        error instanceof Error ? error.message : 'Unknown Telegram processing error',
      );
    }
  }

  /**
   * Atiende un mensaje proveniente de un chat no vinculado.
   *
   * Para /start ofrece el mensaje de bienvenida con el Chat ID; para el resto,
   * el mensaje informativo de chat no vinculado. Registra la interacción como
   * IGNORED con el motivo `chat_not_linked`.
   *
   * Efectos secundarios: envía mensajes por Telegram y persiste un log de interacción.
   */
  private async handleUnlinkedMessage(message: ParsedTelegramMessage, parsed: ParsedCommand): Promise<void> {
    const reply = parsed.command === '/start'
      ? this.formatter.unlinkedStartMessage(message.chatId)
      : this.formatter.unlinkedMessage(message.chatId);

    await this.sendChunks(message.chatId, reply);
    await this.logMessage(message, undefined, parsed.command, 'IGNORED', undefined, { reason: 'chat_not_linked' });
  }

  /**
   * Construye la respuesta para un chat ya vinculado en función del comando
   * interpretado.
   *
   * Despacha cada comando soportado (/start, /ayuda, /chat, /recordatorios,
   * /recomendaciones, /costos, /oportunidades) a su manejador. El texto libre
   * (`TEXT`) se trata como una pregunta de chat, y los comandos desconocidos
   * devuelven la ayuda.
   *
   * @param link - Vínculo activo del chat con el usuario/tenant.
   * @param parsed - Comando y argumento interpretados del mensaje.
   * @param originalText - Texto original del mensaje (usado para el caso `TEXT`).
   * @returns El texto de respuesta a enviar al usuario.
   */
  private async buildLinkedReply(
    link: TelegramChatLink,
    parsed: ParsedCommand,
    originalText: string,
  ): Promise<string> {
    switch (parsed.command) {
      case '/start':
        return [
          `Chat vinculado a ${link.user?.email ?? 'usuario FinOps'}.`,
          '',
          this.formatter.helpMessage(this.botUsername),
        ].join('\n');
      case '/ayuda':
        return this.formatter.helpMessage(this.botUsername);
      case '/chat':
        return this.answerChat(link, parsed.argument);
      case '/recordatorios':
        return this.formatSavingsReminders(link);
      case '/recomendaciones':
        return this.formatRecommendations(link);
      case '/costos':
        return this.formatCosts(link);
      case '/oportunidades':
        return this.formatOpportunities(link);
      case 'TEXT':
        return this.answerChat(link, originalText);
      default:
        return [
          `No reconozco el comando ${parsed.command}.`,
          '',
          this.formatter.helpMessage(this.botUsername),
        ].join('\n');
    }
  }

  /**
   * Responde una pregunta de chat delegando en el servicio de IA FinOps.
   *
   * Si la pregunta viene vacía, devuelve una indicación de uso en lugar de
   * invocar al modelo.
   *
   * Efecto secundario: invoca al servicio de IA (que a su vez puede consultar
   * contexto y modelo).
   *
   * @param link - Vínculo activo con tenant y usuario para acotar el contexto.
   * @param question - Pregunta del usuario.
   * @returns La respuesta del asistente, o una indicación de uso si no hay pregunta.
   */
  private async answerChat(link: TelegramChatLink, question: string): Promise<string> {
    const trimmed = question.trim();

    if (trimmed === '') {
      return 'Escribe tu pregunta despues de /chat. Ejemplo: /chat Que servicios tienen mayor ahorro potencial?';
    }

    const response = await this.aiService.answerChat({
      tenantId: link.tenantId,
      userId: link.userId,
      message: trimmed,
    });

    return response.answer;
  }

  /**
   * Obtiene los recordatorios de ahorro del usuario y delega su formateo en
   * {@link renderSavingsReminders}.
   *
   * Efecto secundario: consulta el servicio de recordatorios de ahorro.
   *
   * @param link - Vínculo activo con tenant y usuario.
   * @returns El texto con los recordatorios, o un aviso si no hay ninguno activo.
   */
  private async formatSavingsReminders(link: TelegramChatLink): Promise<string> {
    const result = await this.savingsReminderService.getNotificationsForUser({
      tenantId: link.tenantId,
      userId: link.userId,
    });

    return renderSavingsReminders(result.notifications);
  }

  /**
   * Obtiene las recomendaciones del tenant y delega su formateo en
   * {@link renderRecommendations}.
   *
   * Efecto secundario: consulta el repositorio de recomendaciones.
   *
   * @param link - Vínculo activo que aporta el tenant.
   * @returns El texto con las recomendaciones, o un aviso si no hay ninguna activa.
   */
  private async formatRecommendations(link: TelegramChatLink): Promise<string> {
    const recommendations = await this.recommendationRepository.findByTenant({ tenantId: link.tenantId });

    return renderRecommendations(recommendations);
  }

  /**
   * Obtiene el último snapshot de costos del tenant y delega su formateo en
   * {@link renderCosts}.
   *
   * Efecto secundario: consulta el repositorio de analítica de costos.
   *
   * @param link - Vínculo activo que aporta el tenant.
   * @returns El texto con el resumen de costos.
   */
  private async formatCosts(link: TelegramChatLink): Promise<string> {
    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(link.tenantId);

    return renderCosts(snapshot);
  }

  /**
   * Obtiene el último snapshot de costos del tenant y delega el formateo de las
   * oportunidades en {@link renderOpportunities}.
   *
   * Efecto secundario: consulta el repositorio de analítica de costos.
   *
   * @param link - Vínculo activo que aporta el tenant.
   * @returns El texto con las oportunidades, o un aviso si no hay evidencia disponible.
   */
  private async formatOpportunities(link: TelegramChatLink): Promise<string> {
    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(link.tenantId);

    return renderOpportunities(snapshot);
  }

  /**
   * Envía un texto al chat dividiéndolo previamente en fragmentos que respeten
   * el límite de Telegram, enviando cada fragmento como un mensaje separado.
   *
   * Efecto secundario: una o varias llamadas de envío a través del cliente de Telegram.
   */
  private async sendChunks(chatId: string, text: string): Promise<void> {
    for (const chunk of this.formatter.split(text)) {
      await this.telegramClient.sendMessage({ chatId, text: chunk });
    }
  }

  /**
   * Registra una interacción de Telegram en el log de auditoría.
   *
   * Incluye tenant y usuario solo cuando hay vínculo, recorta el texto a una
   * vista previa acotada y añade error o metadatos cuando se proporcionan.
   *
   * Efecto secundario: persiste un log de interacción.
   *
   * @param message - Mensaje parseado que originó la interacción.
   * @param link - Vínculo asociado, o `undefined` si el chat no está vinculado.
   * @param command - Comando interpretado.
   * @param status - Estado final de la interacción (PROCESSED, IGNORED, ERROR...).
   * @param errorMessage - Mensaje de error a registrar (opcional).
   * @param metadata - Metadatos adicionales del contexto (opcional).
   */
  private async logMessage(
    message: ParsedTelegramMessage,
    link: TelegramChatLink | undefined,
    command: string,
    status: Parameters<ITelegramRepository['createInteractionLog']>[0]['status'],
    errorMessage?: string,
    metadata?: unknown,
  ): Promise<void> {
    await this.repository.createInteractionLog({
      ...(link !== undefined ? { tenantId: link.tenantId, userId: link.userId } : {}),
      chatId: message.chatId,
      ...(message.telegramUserId !== undefined ? { telegramUserId: message.telegramUserId } : {}),
      ...(message.telegramUsername !== undefined ? { telegramUsername: message.telegramUsername } : {}),
      command,
      status,
      textPreview: truncatePreview(message.text),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }
}

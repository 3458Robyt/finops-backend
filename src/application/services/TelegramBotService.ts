import type { FinOpsAiService } from './FinOpsAiService.js';
import type { TelegramMessageFormatter } from './TelegramMessageFormatter.js';
import type { ITelegramClient } from './TelegramClient.js';
import type { SavingsReminderService } from './SavingsReminderService.js';
import type { ICostAnalyticsRepository } from '../../domain/interfaces/ICostAnalyticsRepository.js';
import type { IRecommendationRepository } from '../../domain/interfaces/IRecommendationRepository.js';
import type { ITelegramRepository } from '../../domain/interfaces/ITelegramRepository.js';
import type { TelegramChatLink, TelegramInteractionStatus } from '../../domain/models/Telegram.js';
import type { FinOpsRecommendation } from '../../domain/models/FinOpsRecommendation.js';

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

interface ParsedTelegramMessage {
  readonly chatId: string;
  readonly telegramUserId?: string;
  readonly telegramUsername?: string;
  readonly text: string;
}

interface ParsedCommand {
  readonly command: string;
  readonly argument: string;
}

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

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

  public async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = this.parseMessage(update);

    if (message === null) {
      await this.repository.createInteractionLog({
        chatId: 'unknown',
        status: 'IGNORED',
        metadata: { reason: 'unsupported_update', updateId: update.update_id },
      });
      return;
    }

    const parsed = this.parseCommand(message.text);

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

  private async handleUnlinkedMessage(message: ParsedTelegramMessage, parsed: ParsedCommand): Promise<void> {
    const reply = parsed.command === '/start'
      ? this.formatter.unlinkedStartMessage(message.chatId)
      : this.formatter.unlinkedMessage(message.chatId);

    await this.sendChunks(message.chatId, reply);
    await this.logMessage(message, undefined, parsed.command, 'IGNORED', undefined, { reason: 'chat_not_linked' });
  }

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

  private async formatSavingsReminders(link: TelegramChatLink): Promise<string> {
    const result = await this.savingsReminderService.getNotificationsForUser({
      tenantId: link.tenantId,
      userId: link.userId,
    });

    if (result.notifications.length === 0) {
      return 'No hay recordatorios de ahorro activos para este usuario.';
    }

    const lines = result.notifications.slice(0, 5).map((notification, index) => [
      `${index + 1}. ${notification.title}`,
      notification.message,
      notification.missedSavingsAmount !== undefined
        ? `Ahorro no capturado: ${formatCurrency(notification.missedSavingsAmount, notification.currency)}`
        : undefined,
    ].filter((line): line is string => line !== undefined).join('\n'));

    return ['Recordatorios de ahorro:', '', ...lines].join('\n\n');
  }

  private async formatRecommendations(link: TelegramChatLink): Promise<string> {
    const recommendations = await this.recommendationRepository.findByTenant({ tenantId: link.tenantId });
    const active = recommendations
      .filter((recommendation) => recommendation.status === 'PENDING' || recommendation.status === 'APPROVED')
      .sort((left, right) => (right.estimatedMonthlySavings ?? 0) - (left.estimatedMonthlySavings ?? 0))
      .slice(0, 5);

    if (active.length === 0) {
      return 'No hay recomendaciones pendientes o aprobadas en este momento.';
    }

    return [
      'Recomendaciones activas:',
      '',
      ...active.map((recommendation, index) => this.formatRecommendationLine(recommendation, index)),
    ].join('\n\n');
  }

  private async formatCosts(link: TelegramChatLink): Promise<string> {
    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(link.tenantId);
    const providers = snapshot.providers
      .slice(0, 3)
      .map((provider) => `- ${provider.provider}: ${formatCurrency(provider.totalCost, snapshot.currency)}`)
      .join('\n');
    const services = snapshot.services
      .slice(0, 5)
      .map((service) => `- ${service.serviceName}: ${formatCurrency(service.totalCost, snapshot.currency)}`)
      .join('\n');

    return [
      'Resumen de costos FinOps:',
      `Periodo: ${formatDate(snapshot.periodStart)} a ${formatDate(snapshot.periodEnd)}`,
      `Costo total: ${formatCurrency(snapshot.totalCost, snapshot.currency)}`,
      `Metricas: ${snapshot.metricCount}`,
      '',
      'Proveedores principales:',
      providers !== '' ? providers : '- Sin datos',
      '',
      'Servicios principales:',
      services !== '' ? services : '- Sin datos',
    ].join('\n');
  }

  private async formatOpportunities(link: TelegramChatLink): Promise<string> {
    const snapshot = await this.analyticsRepository.getLatestTenantSnapshot(link.tenantId);
    const anomalyLines = (snapshot.anomalies ?? []).slice(0, 3).map((opportunity) => (
      `- ${opportunity.explanation} (${formatCurrency(opportunity.deltaAmount, snapshot.currency)})`
    ));
    const insightLines = (snapshot.usageInsights ?? []).slice(0, 3).map((insight) => (
      `- ${insight.title}: ${insight.description}`
    ));
    const lines = [...anomalyLines, ...insightLines].slice(0, 5);

    if (lines.length === 0) {
      return 'No hay oportunidades activas con la evidencia disponible.';
    }

    return ['Oportunidades detectadas:', '', ...lines].join('\n');
  }

  private formatRecommendationLine(recommendation: FinOpsRecommendation, index: number): string {
    const savings = recommendation.estimatedMonthlySavings !== undefined
      ? formatCurrency(recommendation.estimatedMonthlySavings, recommendation.currency)
      : 'Ahorro no estimado';

    return [
      `${index + 1}. ${recommendation.title}`,
      `Estado: ${recommendation.status}`,
      `Ahorro estimado: ${savings}/mes`,
      `Severidad: ${recommendation.severity}`,
    ].join('\n');
  }

  private parseMessage(update: TelegramUpdate): ParsedTelegramMessage | null {
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

  private parseCommand(text: string): ParsedCommand {
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

  private async sendChunks(chatId: string, text: string): Promise<void> {
    for (const chunk of this.formatter.split(text)) {
      await this.telegramClient.sendMessage({ chatId, text: chunk });
    }
  }

  private async logMessage(
    message: ParsedTelegramMessage,
    link: TelegramChatLink | undefined,
    command: string,
    status: TelegramInteractionStatus,
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

function truncatePreview(value: string): string {
  return value.length <= 240 ? value : value.slice(0, 237).concat('...');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('es-CO');
}

function formatCurrency(value: number, currency: string): string {
  if (currency === 'USD') {
    return currencyFormatter.format(value);
  }

  return `${currency} ${value.toFixed(2)}`;
}

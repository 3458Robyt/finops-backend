import type { IExecutiveSummaryService } from '../../domain/interfaces/IExecutiveSummaryService.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { ITelegramRepository } from '../../domain/interfaces/ITelegramRepository.js';
import type { OutboundMessageChannel, OutboundMessageDelivery } from '../../domain/models/OutboundMessage.js';
import { formatExecutiveSummary } from './telegram/executiveSummaryFormatter.js';
import type { MessagingPreferenceService } from './MessagingPreferenceService.js';

export class ExecutiveSummaryDeliveryService {
  constructor(
    private readonly summaryService: IExecutiveSummaryService,
    private readonly outboundRepository: IOutboundMessageRepository,
    private readonly telegramRepository: ITelegramRepository,
    private readonly emailEnabled: boolean,
    private readonly telegramEnabled: boolean,
    private readonly preferences: MessagingPreferenceService | undefined = undefined,
  ) {}

  public async send(tenantId: string): Promise<readonly OutboundMessageDelivery[]> {
    const summary = await this.summaryService.getSummary(tenantId);
    const text = formatExecutiveSummary(summary);
    const summaryDate = summary.generatedAt.toISOString().slice(0, 10);
    const [users, links] = await Promise.all([
      this.outboundRepository.findTenantUsers(tenantId),
      this.telegramRepository.findLinksByTenant(tenantId),
    ]);
    const deliveries: OutboundMessageDelivery[] = [];

    for (const user of users.filter((item) => item.status === 'ACTIVE')) {
      const emailKey = `EXECUTIVE_SUMMARY:${summaryDate}:${user.id}:EMAIL`;
      if (await this.allows(user.id, 'EMAIL') && !(await this.hasDedupe(tenantId, user.id, 'EMAIL', emailKey))) {
        deliveries.push(await this.enqueueEmail(tenantId, user.id, user.email, text, emailKey, summaryDate));
      }
      const link = links.find((item) => item.userId === user.id && item.status === 'ACTIVE');
      if (link === undefined || !(await this.allows(user.id, 'TELEGRAM'))) continue;
      const telegramKey = `EXECUTIVE_SUMMARY:${summaryDate}:${user.id}:TELEGRAM`;
      if (!(await this.hasDedupe(tenantId, user.id, 'TELEGRAM', telegramKey))) {
        deliveries.push(await this.enqueueTelegram(tenantId, user.id, link.chatId, text, telegramKey, summaryDate));
      }
    }

    return deliveries;
  }

  private async enqueueEmail(tenantId: string, userId: string, to: string, text: string, dedupeKey: string, summaryDate: string): Promise<OutboundMessageDelivery> {
    const metadata = { to, dedupeKey, summaryDate };
    if (!this.emailEnabled) {
      return this.outboundRepository.create({ tenantId, userId, channel: 'EMAIL', messageType: 'EXECUTIVE_SUMMARY', status: 'SKIPPED', subject: 'Resumen ejecutivo FinOps', preview: truncate(text), errorMessage: 'Email channel disabled', metadata });
    }
    return this.outboundRepository.create({ tenantId, userId, channel: 'EMAIL', messageType: 'EXECUTIVE_SUMMARY', status: 'PENDING', subject: 'Resumen ejecutivo FinOps', preview: truncate(text), body: text, maxAttempts: 3, metadata });
  }

  private async enqueueTelegram(tenantId: string, userId: string, chatId: string, text: string, dedupeKey: string, summaryDate: string): Promise<OutboundMessageDelivery> {
    const metadata = { chatId, dedupeKey, summaryDate };
    if (!this.telegramEnabled) {
      return this.outboundRepository.create({ tenantId, userId, channel: 'TELEGRAM', messageType: 'EXECUTIVE_SUMMARY', status: 'SKIPPED', preview: truncate(text), errorMessage: 'Telegram channel disabled', metadata });
    }
    return this.outboundRepository.create({ tenantId, userId, channel: 'TELEGRAM', messageType: 'EXECUTIVE_SUMMARY', status: 'PENDING', preview: truncate(text), body: text, maxAttempts: 3, metadata });
  }

  private async hasDedupe(tenantId: string, userId: string, channel: OutboundMessageChannel, dedupeKey: string): Promise<boolean> {
    if (this.outboundRepository.findByDedupeKey === undefined) return false;
    return (await this.outboundRepository.findByDedupeKey({ tenantId, userId, channel, messageType: 'EXECUTIVE_SUMMARY', dedupeKey })) !== null;
  }

  private async allows(userId: string, channel: 'EMAIL' | 'TELEGRAM'): Promise<boolean> {
    return this.preferences === undefined
      ? true
      : this.preferences.allows(userId, channel, 'executive');
  }
}

function truncate(value: string): string { return value.length <= 500 ? value : `${value.slice(0, 497)}...`; }

import { describe, expect, it, vi } from 'vitest';
import type { IExecutiveSummaryService } from '../../domain/interfaces/IExecutiveSummaryService.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { ITelegramRepository } from '../../domain/interfaces/ITelegramRepository.js';
import type { OutboundMessageDelivery } from '../../domain/models/OutboundMessage.js';
import { ExecutiveSummaryDeliveryService } from './ExecutiveSummaryDeliveryService.js';

describe('ExecutiveSummaryDeliveryService', () => {
  it('encola por correo y Telegram con una clave diaria por usuario/canal', async () => {
    const created: Array<Record<string, unknown>> = [];
    const outbound = {
      findTenantUsers: vi.fn(async () => [{ id: 'user-1', email: 'user@example.com', name: 'User', status: 'ACTIVE' as const }]),
      create: vi.fn(async (input: Record<string, unknown>) => {
        created.push(input);
        return delivery(input);
      }),
      findByDedupeKey: vi.fn(async () => null),
    } as unknown as IOutboundMessageRepository;
    const telegram = { findLinksByTenant: vi.fn(async () => [{ id: 'link-1', tenantId: 'tenant-1', userId: 'user-1', chatId: 'chat-1', status: 'ACTIVE' as const }]) } as unknown as ITelegramRepository;
    const summary = { getSummary: vi.fn(async () => ({
      tenantId: 'tenant-1',
      generatedAt: new Date('2026-08-11T12:00:00.000Z'),
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-08-11T00:00:00.000Z',
      totalCost: 100,
      currency: 'USD',
      forecastScenarios: [],
      opportunities: { count: 0, potentialByCurrency: {}, top: [] },
      realization: { generatedAt: new Date(), currencies: [], counts: { identified: 0, approved: 0, executed: 0, withoutMeasurement: 0, waitingForData: 0, readyToCalculate: 0, calculatedPendingReview: 0, insufficientEvidence: 0, verified: 0, rejected: 0 } },
      budgets: [],
      coverage: { status: 'READY', inventoryResources: 0, linkedResourcesWithCost: 0, linkedResourcesWithMetrics: 0, linkedResourcesWithBoth: 0, costPercent: 100, metricsPercent: 100, technicalRecommendationBlockers: [] },
      ingestion: { totalConnections: 1, blockedConnections: 0, partialConnections: 0 },
    })) } as unknown as IExecutiveSummaryService;
    const service = new ExecutiveSummaryDeliveryService(summary, outbound, telegram, true, true);

    const deliveries = await service.send('tenant-1');

    expect(deliveries).toHaveLength(2);
    expect(created).toHaveLength(2);
    expect(created.every((item) => item.messageType === 'EXECUTIVE_SUMMARY')).toBe(true);
    expect(created.every((item) => item.status === 'PENDING')).toBe(true);
    expect(created.every((item) => typeof item.body === 'string' && String(item.body).length > 0)).toBe(true);
    expect(outbound.findByDedupeKey).toHaveBeenCalledTimes(2);
  });
});

function delivery(input: Record<string, unknown>): OutboundMessageDelivery {
  const now = new Date('2026-08-11T12:00:00.000Z');
  return { id: 'delivery-1', tenantId: String(input.tenantId), userId: String(input.userId), channel: input.channel as 'EMAIL' | 'TELEGRAM', messageType: input.messageType as 'EXECUTIVE_SUMMARY', status: input.status as 'SENT', preview: String(input.preview), createdAt: now, updatedAt: now };
}

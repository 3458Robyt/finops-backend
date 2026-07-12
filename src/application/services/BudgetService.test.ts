import { describe, expect, it } from 'vitest';
import { BudgetService } from './BudgetService.js';
import type { IBudgetRepository } from '../../domain/interfaces/IBudgetRepository.js';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { Budget, BudgetAlert } from '../../domain/models/Budget.js';

const actor = { userId: 'user-1', tenantId: 'tenant-1', email: 'admin@example.com', role: 'ADMIN', jwtId: 'jwt-1' } as const;

describe('BudgetService', () => {
  it('creates one threshold event and one notification per user after repeated evaluation', async () => {
    const repository = new FakeBudgetRepository(buildBudget());
    const notifications = new FakeNotifications();
    const outbound = new FakeOutbound();
    const service = new BudgetService(repository as unknown as IBudgetRepository, notifications as unknown as INotificationRepository, outbound as unknown as IOutboundMessageRepository, new FakeTelegram() as any);

    await service.evaluate(actor, 'budget-1');
    await service.evaluate(actor, 'budget-1');

    expect(repository.alerts).toHaveLength(2); // WARNING and CRITICAL, not EXCEEDED.
    expect(notifications.created).toHaveLength(2);
    expect(outbound.created).toHaveLength(2);
  });

  it('does not fabricate a forecast and only uses matching-currency cost', async () => {
    const repository = new FakeBudgetRepository(buildBudget());
    repository.actualCost = 85;
    const service = new BudgetService(repository as unknown as IBudgetRepository, new FakeNotifications() as unknown as INotificationRepository, new FakeOutbound() as unknown as IOutboundMessageRepository, new FakeTelegram() as any);

    const result = await service.getPerformance(actor, 'budget-1', new Date('2026-07-15T00:00:00.000Z'));

    expect(result.actualCost).toBe(85);
    expect(result.forecastCost).toBeUndefined();
    expect(result.health).toBe('WARNING');
  });

  it('allows a viewer to read but not create a budget', async () => {
    const repository = new FakeBudgetRepository(buildBudget());
    const service = new BudgetService(repository as unknown as IBudgetRepository, new FakeNotifications() as unknown as INotificationRepository, new FakeOutbound() as unknown as IOutboundMessageRepository, new FakeTelegram() as any);
    const viewer = { ...actor, role: 'CLIENT_VIEWER' as const };

    await expect(service.getPerformance(viewer, 'budget-1')).resolves.toMatchObject({ actualCost: 95 });
    await expect(service.create(viewer, { scope: 'TENANT', period: '2026-07', amount: 100, currency: 'USD' })).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
  });
});

class FakeBudgetRepository {
  public readonly alerts: BudgetAlert[] = [];
  public actualCost = 95;
  public constructor(private readonly budget: Budget) {}
  public async findById(tenantId: string, id: string): Promise<Budget | null> { return tenantId === this.budget.tenantId && id === this.budget.id ? this.budget : null; }
  public async list(): Promise<readonly Budget[]> { return [this.budget]; }
  public async getActualCost(): Promise<number> { return this.actualCost; }
  public async getForecastCost(): Promise<number | undefined> { return undefined; }
  public async cloudAccountExists(): Promise<boolean> { return true; }
  public async createAlertIfAbsent(input: Omit<BudgetAlert, 'id' | 'createdAt'>): Promise<BudgetAlert | null> { if (this.alerts.some((alert) => alert.idempotencyKey === input.idempotencyKey)) return null; const alert: BudgetAlert = { ...input, id: `alert-${this.alerts.length + 1}`, createdAt: new Date() }; this.alerts.push(alert); return alert; }
  public async listAlerts(): Promise<readonly BudgetAlert[]> { return this.alerts; }
  public async create(): Promise<Budget> { return this.budget; }
  public async update(): Promise<Budget> { return this.budget; }
  public async archive(): Promise<Budget> { return this.budget; }
}
class FakeNotifications { public readonly created: unknown[] = []; public async create(input: unknown): Promise<any> { this.created.push(input); return input; } }
class FakeOutbound { public readonly created: unknown[] = []; public async findTenantUsers() { return [{ id: 'recipient-1', email: 'recipient@example.com', name: 'Recipient', status: 'ACTIVE' as const }]; } public async create(input: unknown): Promise<any> { this.created.push(input); return input; } }
class FakeTelegram { public async findLinksByTenant() { return []; } }
function buildBudget(): Budget { const now = new Date('2026-07-01T00:00:00.000Z'); return { id: 'budget-1', tenantId: 'tenant-1', scope: 'TENANT', scopeKey: '__tenant__', periodStart: now, amount: 100, currency: 'USD', warningThreshold: 0.8, criticalThreshold: 0.9, exceededThreshold: 1, status: 'ACTIVE', createdByUserId: 'user-1', createdAt: now, updatedAt: now }; }

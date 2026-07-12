import { AuthorizationError, FinOpsBaseError } from '../../domain/errors/errors.js';
import type { IBudgetRepository, CreateBudgetInput, UpdateBudgetInput } from '../../domain/interfaces/IBudgetRepository.js';
import type { INotificationRepository } from '../../domain/interfaces/INotificationRepository.js';
import type { IOutboundMessageRepository } from '../../domain/interfaces/IOutboundMessageRepository.js';
import type { AuthContext } from '../../domain/models/AuthContext.js';
import type { Budget, BudgetAlert, BudgetHealth, BudgetPerformance, BudgetScope } from '../../domain/models/Budget.js';

const managerRoles = new Set<AuthContext['role']>(['MASTER_ADMIN', 'OPERATOR_ADMIN', 'ADMIN', 'FINOPS_TECHNICIAN']);
const utcMonth = /^\d{4}-(0[1-9]|1[0-2])$/;

export class BudgetService {
  constructor(
    private readonly budgets: IBudgetRepository,
    private readonly notifications: INotificationRepository,
    private readonly outbound: IOutboundMessageRepository,
  ) {}

  public async list(actor: AuthContext, input: { period?: string; cloudAccountId?: string; serviceName?: string }): Promise<readonly Budget[]> {
    return this.budgets.list({ tenantId: actor.tenantId, ...(input.period !== undefined ? { periodStart: parseMonth(input.period) } : {}), ...(input.cloudAccountId !== undefined ? { cloudAccountId: input.cloudAccountId } : {}), ...(input.serviceName !== undefined ? { serviceName: input.serviceName } : {}), status: 'ACTIVE' });
  }

  public async create(actor: AuthContext, input: { scope: BudgetScope; scopeKey?: string; cloudAccountId?: string; serviceName?: string; period: string; amount: number; currency: string; warningThreshold?: number; criticalThreshold?: number; exceededThreshold?: number }): Promise<Budget> {
    this.requireManager(actor);
    const periodStart = parseMonth(input.period);
    const currency = input.currency.trim().toUpperCase();
    const scopeKey = this.resolveScopeKey(input);
    const thresholds = normalizeThresholds(input);
    if (!Number.isFinite(input.amount) || input.amount <= 0) throw new FinOpsBaseError('Budget amount must be positive', 'VALIDATION_ERROR');
    if (!/^[A-Z]{3}$/.test(currency)) throw new FinOpsBaseError('Currency must be ISO-4217 uppercase code', 'VALIDATION_ERROR');
    if (input.scope === 'CLOUD_ACCOUNT' && !(await this.budgets.cloudAccountExists(actor.tenantId, scopeKey))) {
      throw new FinOpsBaseError('Cloud account not found for this tenant', 'NOT_FOUND');
    }
    return this.budgets.create({ tenantId: actor.tenantId, scope: input.scope, scopeKey, ...(input.cloudAccountId !== undefined ? { cloudAccountId: input.cloudAccountId } : {}), ...(input.serviceName !== undefined ? { serviceName: input.serviceName } : {}), periodStart, amount: input.amount, currency, ...thresholds, createdByUserId: actor.userId });
  }

  public async update(actor: AuthContext, budgetId: string, input: UpdateBudgetInput): Promise<Budget> {
    this.requireManager(actor); this.validateUpdate(input);
    const current = await this.requireBudget(actor, budgetId);
    normalizeThresholds({
      warningThreshold: input.warningThreshold ?? current.warningThreshold,
      criticalThreshold: input.criticalThreshold ?? current.criticalThreshold,
      exceededThreshold: input.exceededThreshold ?? current.exceededThreshold,
    });
    const budget = await this.budgets.update(actor.tenantId, budgetId, input);
    if (budget === null) throw new FinOpsBaseError('Budget not found or archived', 'NOT_FOUND');
    return budget;
  }

  public async archive(actor: AuthContext, budgetId: string): Promise<Budget> {
    this.requireManager(actor);
    const budget = await this.budgets.archive(actor.tenantId, budgetId, new Date());
    if (budget === null) throw new FinOpsBaseError('Budget not found or already archived', 'NOT_FOUND');
    return budget;
  }

  public async getPerformance(actor: AuthContext, budgetId: string, now = new Date()): Promise<BudgetPerformance> {
    const budget = await this.requireBudget(actor, budgetId);
    const [actualCost, forecastCost] = await Promise.all([this.budgets.getActualCost(budget), this.budgets.getForecastCost(budget)]);
    const consumedPercent = round((actualCost / budget.amount) * 100);
    const health = healthFor(budget, Math.max(actualCost, forecastCost ?? 0));
    return { budget, actualCost, remainingBudget: round(budget.amount - actualCost), consumedPercent, ...(forecastCost !== undefined ? { forecastCost, varianceAmount: round(forecastCost - budget.amount), variancePercent: round(((forecastCost - budget.amount) / budget.amount) * 100) } : {}), health, ...(depletionDate(budget, actualCost, now) !== undefined ? { estimatedDepletionDate: depletionDate(budget, actualCost, now)! } : {}) };
  }

  public async evaluate(actor: AuthContext, budgetId?: string): Promise<{ readonly evaluated: number; readonly newAlerts: readonly BudgetAlert[] }> {
    this.requireManager(actor);
    const selected = budgetId === undefined ? await this.budgets.list({ tenantId: actor.tenantId, status: 'ACTIVE' }) : [await this.requireBudget(actor, budgetId)];
    const newAlerts: BudgetAlert[] = [];
    for (const budget of selected) {
      const performance = await this.getPerformance(actor, budget.id);
      for (const [level, threshold] of [['WARNING', budget.warningThreshold], ['CRITICAL', budget.criticalThreshold], ['EXCEEDED', budget.exceededThreshold]] as const) {
        const comparedCost = Math.max(performance.actualCost, performance.forecastCost ?? 0);
        if (comparedCost < budget.amount * threshold) continue;
        const alert = await this.budgets.createAlertIfAbsent({ tenantId: budget.tenantId, budgetId: budget.id, level, threshold, periodStart: budget.periodStart, actualCost: performance.actualCost, ...(performance.forecastCost !== undefined ? { forecastCost: performance.forecastCost } : {}), currency: budget.currency, idempotencyKey: `${budget.id}:${budget.periodStart.toISOString().slice(0, 10)}:${level}`, metadata: { health: performance.health, source: performance.forecastCost !== undefined && performance.forecastCost >= performance.actualCost ? 'forecast_or_actual' : 'actual' } });
        if (alert !== null) { newAlerts.push(alert); await this.publishAlert(budget, performance, alert); }
      }
    }
    return { evaluated: selected.length, newAlerts };
  }

  public async listAlerts(actor: AuthContext, budgetId: string): Promise<readonly BudgetAlert[]> { await this.requireBudget(actor, budgetId); return this.budgets.listAlerts(actor.tenantId, budgetId); }
  private async requireBudget(actor: AuthContext, id: string): Promise<Budget> { const budget = await this.budgets.findById(actor.tenantId, id); if (budget === null) throw new FinOpsBaseError('Budget not found', 'NOT_FOUND'); return budget; }
  private requireManager(actor: AuthContext): void { if (!managerRoles.has(actor.role)) throw new AuthorizationError('You are not allowed to manage budgets'); }
  private resolveScopeKey(input: { scope: BudgetScope; scopeKey?: string; cloudAccountId?: string; serviceName?: string }): string { if (input.scope === 'TENANT') return '__tenant__'; const key = input.scope === 'CLOUD_ACCOUNT' ? input.cloudAccountId : input.serviceName; if (key === undefined || key.trim() === '') throw new FinOpsBaseError('Scope target is required', 'VALIDATION_ERROR'); return key.trim(); }
  private validateUpdate(input: UpdateBudgetInput): void { if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount <= 0)) throw new FinOpsBaseError('Budget amount must be positive', 'VALIDATION_ERROR'); if ([input.warningThreshold, input.criticalThreshold, input.exceededThreshold].some((v) => v !== undefined && (!Number.isFinite(v) || v <= 0))) throw new FinOpsBaseError('Thresholds must be positive', 'VALIDATION_ERROR'); }
  private async publishAlert(budget: Budget, performance: BudgetPerformance, alert: BudgetAlert): Promise<void> { const users = await this.outbound.findTenantUsers(budget.tenantId); const percent = performance.consumedPercent.toFixed(1); const text = `Presupuesto ${alert.level.toLowerCase()}: ${budget.currency} ${performance.actualCost.toFixed(2)} consumidos (${percent}% de ${budget.amount.toFixed(2)}).`; await Promise.all(users.filter((u) => u.status === 'ACTIVE').map(async (user) => { await this.notifications.create({ tenantId: budget.tenantId, userId: user.id, type: 'BUDGET_ALERT', title: 'Alerta de presupuesto', message: text, currency: budget.currency, periodStart: budget.periodStart, generatedForDate: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())), metadata: { budgetId: budget.id, budgetAlertId: alert.id, level: alert.level } }); await this.outbound.create({ tenantId: budget.tenantId, userId: user.id, channel: 'EMAIL', messageType: 'BUDGET_ALERT', status: 'PENDING', subject: 'Alerta de presupuesto FinOps', preview: text, metadata: { budgetAlertId: alert.id, budgetId: budget.id } }); })); }
}

function parseMonth(value: string): Date { if (!utcMonth.test(value)) throw new FinOpsBaseError('Period must be YYYY-MM', 'VALIDATION_ERROR'); const [year, month] = value.split('-').map(Number); return new Date(Date.UTC(year!, month! - 1, 1)); }
function normalizeThresholds(input: { warningThreshold?: number; criticalThreshold?: number; exceededThreshold?: number }): { warningThreshold: number; criticalThreshold: number; exceededThreshold: number } { const warningThreshold = input.warningThreshold ?? 0.8, criticalThreshold = input.criticalThreshold ?? 0.9, exceededThreshold = input.exceededThreshold ?? 1; if (!(warningThreshold > 0 && warningThreshold < criticalThreshold && criticalThreshold < exceededThreshold)) throw new FinOpsBaseError('Thresholds must be ordered: warning < critical < exceeded', 'VALIDATION_ERROR'); return { warningThreshold, criticalThreshold, exceededThreshold }; }
function healthFor(b: Budget, cost: number): BudgetHealth { const ratio = cost / b.amount; return ratio >= b.exceededThreshold ? 'EXCEEDED' : ratio >= b.criticalThreshold ? 'CRITICAL' : ratio >= b.warningThreshold ? 'WARNING' : 'HEALTHY'; }
function depletionDate(b: Budget, actual: number, now: Date): Date | undefined { const elapsed = Math.max(0, (now.getTime() - b.periodStart.getTime()) / 86400000); if (elapsed < 1 || actual <= 0) return undefined; const date = new Date(b.periodStart.getTime() + (b.amount / (actual / elapsed)) * 86400000); const end = new Date(Date.UTC(b.periodStart.getUTCFullYear(), b.periodStart.getUTCMonth() + 1, 1)); return date > now && date < end ? date : undefined; }
function round(value: number): number { return Math.round(value * 100) / 100; }

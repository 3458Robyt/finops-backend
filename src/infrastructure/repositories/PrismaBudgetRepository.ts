import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { FinOpsBaseError } from '../../domain/errors/errors.js';
import type { Budget, BudgetActualCost, BudgetAlert } from '../../domain/models/Budget.js';
import type { BudgetFilters, CreateBudgetInput, IBudgetRepository, UpdateBudgetInput } from '../../domain/interfaces/IBudgetRepository.js';
import { PrismaCostAllocationRepository } from './PrismaCostAllocationRepository.js';

export class PrismaBudgetRepository implements IBudgetRepository {
  private readonly allocation: PrismaCostAllocationRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.allocation = new PrismaCostAllocationRepository(prisma);
  }

  public async create(input: CreateBudgetInput): Promise<Budget> {
    try {
      const row = await this.prisma.budget.create({ data: input });
      return toBudget(row);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new FinOpsBaseError('An active budget already exists for this scope and period', 'VALIDATION_ERROR');
      }
      throw error;
    }
  }

  public async findById(tenantId: string, id: string): Promise<Budget | null> {
    const row = await this.prisma.budget.findFirst({ where: { id, tenantId } });
    return row === null ? null : toBudget(row);
  }

  public async list(filters: BudgetFilters): Promise<readonly Budget[]> {
    const rows = await this.prisma.budget.findMany({
      where: {
        tenantId: filters.tenantId,
        ...(filters.periodStart !== undefined ? { periodStart: filters.periodStart } : {}),
        ...(filters.cloudAccountId !== undefined ? { cloudAccountId: filters.cloudAccountId } : {}),
        ...(filters.serviceName !== undefined ? { serviceName: filters.serviceName } : {}),
        ...(filters.status !== undefined ? { status: filters.status } : {}),
      },
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toBudget);
  }

  public async update(tenantId: string, id: string, input: UpdateBudgetInput): Promise<Budget | null> {
    const result = await this.prisma.budget.updateMany({ where: { id, tenantId, status: 'ACTIVE' }, data: input });
    return result.count === 0 ? null : this.findById(tenantId, id);
  }

  public async archive(tenantId: string, id: string, archivedAt: Date): Promise<Budget | null> {
    const result = await this.prisma.budget.updateMany({ where: { id, tenantId, status: 'ACTIVE' }, data: { status: 'ARCHIVED', archivedAt } });
    return result.count === 0 ? null : this.findById(tenantId, id);
  }

  public async getActualCost(budget: Budget): Promise<BudgetActualCost> {
    if (budget.scope === 'ALLOCATION_DESTINATION') return this.getAllocationDestinationCost(budget);
    const next = nextMonth(budget.periodStart);
    const rows = await this.prisma.$queryRaw<readonly { total: Prisma.Decimal | null }[]>(Prisma.sql`
      SELECT COALESCE(SUM("billed_cost"), 0) AS total
      FROM "cost_metrics"
      WHERE "tenant_id" = ${budget.tenantId}
        AND "billing_currency" = ${budget.currency}
        AND "charge_period_start" >= ${budget.periodStart}
        AND "charge_period_start" < ${next}
        ${budget.scope === 'CLOUD_ACCOUNT' ? Prisma.sql`AND "cloud_account_id" = ${budget.scopeKey}` : Prisma.empty}
        ${budget.scope === 'SERVICE' ? Prisma.sql`AND "service_name" = ${budget.scopeKey}` : Prisma.empty}
    `);
    return { amount: Number(rows[0]?.total ?? 0), available: true, source: 'COST_METRICS' };
  }

  public async cloudAccountExists(tenantId: string, cloudAccountId: string): Promise<boolean> {
    return (await this.prisma.cloudAccount.count({ where: { tenantId, id: cloudAccountId } })) > 0;
  }

  public async getForecastCost(budget: Budget): Promise<number | undefined> {
    if (budget.scope === 'ALLOCATION_DESTINATION') return undefined;
    const groupings = budget.scope === 'TENANT'
      ? ['total', 'service', 'account']
      : budget.scope === 'CLOUD_ACCOUNT'
        ? ['service', 'account']
        : ['service'];
    for (const groupBy of groupings) {
      const rows = await this.prisma.costForecast.findMany({
        where: {
          tenantId: budget.tenantId,
          forecastMonth: budget.periodStart,
          currency: budget.currency,
          groupBy,
          ...(budget.scope === 'CLOUD_ACCOUNT' ? { cloudAccountId: budget.scopeKey } : {}),
          ...(budget.scope === 'SERVICE' ? { serviceName: budget.scopeKey } : {}),
        },
        select: { predictedCost: true },
      });
      if (rows.length > 0) return rows.reduce((total, row) => total + Number(row.predictedCost), 0);
    }
    return undefined;
  }

  private async getAllocationDestinationCost(budget: Budget): Promise<BudgetActualCost> {
    const closures = await this.allocation.listClosures(budget.tenantId, budget.periodStart);
    const closure = closures.find((item) => item.status === 'CLOSED' && item.currency === budget.currency);
    if (closure !== undefined) return { amount: destinationTotal(closure.results, budget.scopeKey), available: true, source: 'CLOSED_ALLOCATION' };
    return { amount: 0, available: false, source: 'NO_CLOSED_ALLOCATION' };
  }

  public async createAlertIfAbsent(input: Omit<BudgetAlert, 'id' | 'createdAt'>): Promise<BudgetAlert | null> {
    try {
      const row = await this.prisma.budgetAlert.create({ data: {
        tenantId: input.tenantId,
        budgetId: input.budgetId,
        level: input.level,
        threshold: input.threshold,
        periodStart: input.periodStart,
        actualCost: input.actualCost,
        ...(input.forecastCost !== undefined ? { forecastCost: input.forecastCost } : {}),
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
        ...(input.metadata !== undefined ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
      } });
      return toBudgetAlert(row);
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }
  }

  public async listAlerts(tenantId: string, budgetId: string): Promise<readonly BudgetAlert[]> {
    const rows = await this.prisma.budgetAlert.findMany({ where: { tenantId, budgetId }, orderBy: { createdAt: 'desc' } });
    return rows.map(toBudgetAlert);
  }
}

function nextMonth(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1)); }
function destinationTotal(rows: readonly { readonly allocationKey: string; readonly cost: number }[], allocationKey: string): number { return rows.filter((row) => row.allocationKey === allocationKey).reduce((total, row) => total + row.cost, 0); }
function toBudget(row: any): Budget { return { ...row, cloudAccountId: row.cloudAccountId ?? undefined, serviceName: row.serviceName ?? undefined, archivedAt: row.archivedAt ?? undefined, amount: Number(row.amount), warningThreshold: Number(row.warningThreshold), criticalThreshold: Number(row.criticalThreshold), exceededThreshold: Number(row.exceededThreshold) }; }
function toBudgetAlert(row: any): BudgetAlert { return { ...row, forecastCost: row.forecastCost === null ? undefined : Number(row.forecastCost), actualCost: Number(row.actualCost), threshold: Number(row.threshold), metadata: row.metadata ?? undefined }; }

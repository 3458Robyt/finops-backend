import type { Budget, BudgetAlert, BudgetScope, BudgetStatus } from '../models/Budget.js';

export interface CreateBudgetInput {
  readonly tenantId: string;
  readonly cloudAccountId?: string;
  readonly scope: BudgetScope;
  readonly scopeKey: string;
  readonly serviceName?: string;
  readonly periodStart: Date;
  readonly amount: number;
  readonly currency: string;
  readonly warningThreshold: number;
  readonly criticalThreshold: number;
  readonly exceededThreshold: number;
  readonly createdByUserId: string;
}

export interface UpdateBudgetInput {
  readonly amount?: number;
  readonly warningThreshold?: number;
  readonly criticalThreshold?: number;
  readonly exceededThreshold?: number;
}

export interface BudgetFilters {
  readonly tenantId: string;
  readonly periodStart?: Date;
  readonly cloudAccountId?: string;
  readonly serviceName?: string;
  readonly status?: BudgetStatus;
}

export interface ICostByBudgetScope {
  getActualCost(budget: Budget): Promise<number>;
  getForecastCost(budget: Budget): Promise<number | undefined>;
  cloudAccountExists(tenantId: string, cloudAccountId: string): Promise<boolean>;
}

export interface IBudgetRepository extends ICostByBudgetScope {
  create(input: CreateBudgetInput): Promise<Budget>;
  findById(tenantId: string, id: string): Promise<Budget | null>;
  list(filters: BudgetFilters): Promise<readonly Budget[]>;
  update(tenantId: string, id: string, input: UpdateBudgetInput): Promise<Budget | null>;
  archive(tenantId: string, id: string, archivedAt: Date): Promise<Budget | null>;
  createAlertIfAbsent(input: Omit<BudgetAlert, 'id' | 'createdAt'>): Promise<BudgetAlert | null>;
  listAlerts(tenantId: string, budgetId: string): Promise<readonly BudgetAlert[]>;
}

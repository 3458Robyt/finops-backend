export type BudgetScope = 'TENANT' | 'CLOUD_ACCOUNT' | 'SERVICE';
export type BudgetStatus = 'ACTIVE' | 'ARCHIVED';
export type BudgetAlertLevel = 'WARNING' | 'CRITICAL' | 'EXCEEDED';
export type BudgetHealth = 'HEALTHY' | BudgetAlertLevel;

export interface Budget {
  readonly id: string;
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
  readonly status: BudgetStatus;
  readonly createdByUserId: string;
  readonly archivedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BudgetAlert {
  readonly id: string;
  readonly tenantId: string;
  readonly budgetId: string;
  readonly level: BudgetAlertLevel;
  readonly threshold: number;
  readonly periodStart: Date;
  readonly actualCost: number;
  readonly forecastCost?: number;
  readonly currency: string;
  readonly idempotencyKey: string;
  readonly metadata?: unknown;
  readonly createdAt: Date;
}

export interface BudgetPerformance {
  readonly budget: Budget;
  readonly actualCost: number;
  readonly remainingBudget: number;
  readonly consumedPercent: number;
  readonly forecastCost?: number;
  readonly varianceAmount?: number;
  readonly variancePercent?: number;
  readonly health: BudgetHealth;
  readonly estimatedDepletionDate?: Date;
}

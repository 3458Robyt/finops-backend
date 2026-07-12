-- Persistent monthly FinOps budgets and idempotent threshold events.
CREATE TYPE "BudgetScope" AS ENUM ('TENANT', 'CLOUD_ACCOUNT', 'SERVICE');
CREATE TYPE "BudgetStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "BudgetAlertLevel" AS ENUM ('WARNING', 'CRITICAL', 'EXCEEDED');

ALTER TYPE "InAppNotificationType" ADD VALUE IF NOT EXISTS 'BUDGET_ALERT';
ALTER TYPE "OutboundMessageType" ADD VALUE IF NOT EXISTS 'BUDGET_ALERT';

CREATE TABLE "budgets" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cloud_account_id" TEXT,
  "scope" "BudgetScope" NOT NULL,
  "scope_key" TEXT NOT NULL,
  "service_name" TEXT,
  "period_start" DATE NOT NULL,
  "amount" DECIMAL(18,6) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "warning_threshold" DECIMAL(5,4) NOT NULL DEFAULT 0.8,
  "critical_threshold" DECIMAL(5,4) NOT NULL DEFAULT 0.9,
  "exceeded_threshold" DECIMAL(5,4) NOT NULL DEFAULT 1,
  "status" "BudgetStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id" TEXT NOT NULL,
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "budgets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "budgets_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "budgets_thresholds_ordered" CHECK ("warning_threshold" > 0 AND "warning_threshold" < "critical_threshold" AND "critical_threshold" < "exceeded_threshold")
);

CREATE UNIQUE INDEX "budgets_one_active_scope_period" ON "budgets"("tenant_id", "scope", "scope_key", "period_start") WHERE "status" = 'ACTIVE';
CREATE INDEX "budgets_tenant_id_status_period_start_idx" ON "budgets"("tenant_id", "status", "period_start");
CREATE INDEX "budgets_tenant_id_cloud_account_id_period_start_idx" ON "budgets"("tenant_id", "cloud_account_id", "period_start");

ALTER TABLE "budgets" ADD CONSTRAINT "budgets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_cloud_account_id_fkey" FOREIGN KEY ("cloud_account_id") REFERENCES "cloud_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "budget_alerts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "budget_id" TEXT NOT NULL,
  "level" "BudgetAlertLevel" NOT NULL,
  "threshold" DECIMAL(5,4) NOT NULL,
  "period_start" DATE NOT NULL,
  "actual_cost" DECIMAL(18,6) NOT NULL,
  "forecast_cost" DECIMAL(18,6),
  "currency" VARCHAR(3) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "budget_alerts_idempotency_key_key" ON "budget_alerts"("idempotency_key");
CREATE INDEX "budget_alerts_tenant_id_budget_id_period_start_idx" ON "budget_alerts"("tenant_id", "budget_id", "period_start");
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

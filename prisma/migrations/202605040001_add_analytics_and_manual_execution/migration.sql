-- CreateEnum
CREATE TYPE "CostAnomalySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "CostAnomalyStatus" AS ENUM ('OPEN', 'LINKED_TO_RECOMMENDATION', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ManualExecutionStatus" AS ENUM ('PLANNED', 'EXECUTED', 'PARTIAL', 'CANCELLED');

-- CreateTable
CREATE TABLE "cost_anomalies" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cloud_account_id" TEXT,
  "provider" "CloudProvider",
  "service_name" TEXT,
  "resource_id" TEXT,
  "environment" TEXT,
  "period_start" TIMESTAMPTZ(6) NOT NULL,
  "period_end" TIMESTAMPTZ(6) NOT NULL,
  "baseline_cost" DECIMAL(18,6) NOT NULL,
  "observed_cost" DECIMAL(18,6) NOT NULL,
  "delta_amount" DECIMAL(18,6) NOT NULL,
  "delta_percent" DECIMAL(12,6) NOT NULL,
  "z_score" DECIMAL(12,6),
  "severity" "CostAnomalySeverity" NOT NULL,
  "status" "CostAnomalyStatus" NOT NULL DEFAULT 'OPEN',
  "explanation" TEXT NOT NULL,
  "evidence" JSONB,
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cost_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_forecasts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cloud_account_id" TEXT,
  "provider" "CloudProvider",
  "service_name" TEXT,
  "group_by" TEXT NOT NULL,
  "group_key" TEXT NOT NULL,
  "forecast_month" DATE NOT NULL,
  "predicted_cost" DECIMAL(18,6) NOT NULL,
  "lower_bound" DECIMAL(18,6) NOT NULL,
  "upper_bound" DECIMAL(18,6) NOT NULL,
  "method" TEXT NOT NULL,
  "confidence" DECIMAL(5,4) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "evidence" JSONB,
  "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cost_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_manual_executions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "recommendation_id" TEXT NOT NULL,
  "execution_plan_id" TEXT,
  "user_id" TEXT NOT NULL,
  "status" "ManualExecutionStatus" NOT NULL,
  "executed_at" TIMESTAMPTZ(6),
  "observed_monthly_savings" DECIMAL(18,6),
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "notes" TEXT,
  "evidence" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recommendation_manual_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cost_anomalies_tenant_id_cloud_account_id_service_name_resource_id_environment_period_start_key"
ON "cost_anomalies"("tenant_id", "cloud_account_id", "service_name", "resource_id", "environment", "period_start");

-- CreateIndex
CREATE INDEX "cost_anomalies_tenant_id_severity_detected_at_idx"
ON "cost_anomalies"("tenant_id", "severity", "detected_at");

-- CreateIndex
CREATE INDEX "cost_anomalies_tenant_id_status_detected_at_idx"
ON "cost_anomalies"("tenant_id", "status", "detected_at");

-- CreateIndex
CREATE INDEX "cost_anomalies_cloud_account_id_period_start_idx"
ON "cost_anomalies"("cloud_account_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "cost_forecasts_tenant_id_group_by_group_key_forecast_month_key"
ON "cost_forecasts"("tenant_id", "group_by", "group_key", "forecast_month");

-- CreateIndex
CREATE INDEX "cost_forecasts_tenant_id_group_by_generated_at_idx"
ON "cost_forecasts"("tenant_id", "group_by", "generated_at");

-- CreateIndex
CREATE INDEX "cost_forecasts_cloud_account_id_forecast_month_idx"
ON "cost_forecasts"("cloud_account_id", "forecast_month");

-- CreateIndex
CREATE INDEX "recommendation_manual_executions_tenant_id_status_created_at_idx"
ON "recommendation_manual_executions"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_manual_executions_recommendation_id_created_at_idx"
ON "recommendation_manual_executions"("recommendation_id", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_manual_executions_execution_plan_id_created_at_idx"
ON "recommendation_manual_executions"("execution_plan_id", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_manual_executions_user_id_created_at_idx"
ON "recommendation_manual_executions"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "cost_anomalies"
ADD CONSTRAINT "cost_anomalies_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_anomalies"
ADD CONSTRAINT "cost_anomalies_cloud_account_id_fkey"
FOREIGN KEY ("cloud_account_id") REFERENCES "cloud_accounts"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_forecasts"
ADD CONSTRAINT "cost_forecasts_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_forecasts"
ADD CONSTRAINT "cost_forecasts_cloud_account_id_fkey"
FOREIGN KEY ("cloud_account_id") REFERENCES "cloud_accounts"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_manual_executions"
ADD CONSTRAINT "recommendation_manual_executions_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_manual_executions"
ADD CONSTRAINT "recommendation_manual_executions_recommendation_id_fkey"
FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_manual_executions"
ADD CONSTRAINT "recommendation_manual_executions_execution_plan_id_fkey"
FOREIGN KEY ("execution_plan_id") REFERENCES "recommendation_execution_plans"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_manual_executions"
ADD CONSTRAINT "recommendation_manual_executions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

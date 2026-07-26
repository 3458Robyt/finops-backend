-- CreateEnum
CREATE TYPE "SavingsMeasurementStatus" AS ENUM ('WAITING_FOR_DATA', 'READY', 'CALCULATED', 'INSUFFICIENT_EVIDENCE', 'VERIFIED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "SavingsMeasurementScope" AS ENUM ('RESOURCE', 'SERVICE', 'ACCOUNT', 'UNKNOWN');

-- CreateTable
CREATE TABLE "recommendation_savings_measurements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "recommendation_id" TEXT NOT NULL,
    "manual_execution_id" TEXT NOT NULL,
    "execution_plan_id" TEXT,
    "requested_by_user_id" TEXT NOT NULL,
    "verified_by_user_id" TEXT,
    "status" "SavingsMeasurementStatus" NOT NULL DEFAULT 'WAITING_FOR_DATA',
    "scope" "SavingsMeasurementScope" NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "cloud_account_id" TEXT NOT NULL,
    "resource_id" TEXT,
    "service_name" TEXT,
    "executed_at" TIMESTAMPTZ(6) NOT NULL,
    "baseline_start" TIMESTAMPTZ(6) NOT NULL,
    "baseline_end" TIMESTAMPTZ(6) NOT NULL,
    "observation_start" TIMESTAMPTZ(6) NOT NULL,
    "observation_end" TIMESTAMPTZ(6) NOT NULL,
    "window_days" INTEGER NOT NULL,
    "baseline_covered_days" INTEGER NOT NULL DEFAULT 0,
    "observation_covered_days" INTEGER NOT NULL DEFAULT 0,
    "coverage_ratio" DECIMAL(8,6) NOT NULL DEFAULT 0,
    "billing_source" "CostBillingSource" NOT NULL,
    "cost_basis" VARCHAR(16),
    "currency" VARCHAR(3) NOT NULL,
    "baseline_cost" DECIMAL(18,6),
    "observation_cost" DECIMAL(18,6),
    "baseline_daily_cost" DECIMAL(18,6),
    "observation_daily_cost" DECIMAL(18,6),
    "observed_savings" DECIMAL(18,6),
    "projected_monthly_savings" DECIMAL(18,6),
    "cost_increase_monthly_amount" DECIMAL(18,6),
    "baseline_quantity" DECIMAL(24,9),
    "observation_quantity" DECIMAL(24,9),
    "consumed_unit" TEXT,
    "confidence" DECIMAL(5,4),
    "confidence_level" VARCHAR(16),
    "technical_validation_status" VARCHAR(24) NOT NULL DEFAULT 'NOT_EVALUATED',
    "reasons" JSONB,
    "formula" JSONB,
    "evidence" JSONB,
    "evidence_hash" TEXT NOT NULL,
    "calculation_version" VARCHAR(32) NOT NULL,
    "verification_note" TEXT,
    "rejection_reason" TEXT,
    "calculated_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recommendation_savings_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recommendation_savings_measurements_tenant_id_recommendatio_idx" ON "recommendation_savings_measurements"("tenant_id", "recommendation_id", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_savings_measurements_tenant_id_status_create_idx" ON "recommendation_savings_measurements"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_savings_measurements_tenant_id_manual_execut_idx" ON "recommendation_savings_measurements"("tenant_id", "manual_execution_id");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_savings_measurements_manual_execution_id_evi_key" ON "recommendation_savings_measurements"("manual_execution_id", "evidence_hash");

-- AddForeignKey
ALTER TABLE "recommendation_savings_measurements" ADD CONSTRAINT "recommendation_savings_measurements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_savings_measurements" ADD CONSTRAINT "recommendation_savings_measurements_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_savings_measurements" ADD CONSTRAINT "recommendation_savings_measurements_manual_execution_id_fkey" FOREIGN KEY ("manual_execution_id") REFERENCES "recommendation_manual_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_savings_measurements" ADD CONSTRAINT "recommendation_savings_measurements_execution_plan_id_fkey" FOREIGN KEY ("execution_plan_id") REFERENCES "recommendation_execution_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_savings_measurements" ADD CONSTRAINT "recommendation_savings_measurements_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_savings_measurements" ADD CONSTRAINT "recommendation_savings_measurements_verified_by_user_id_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

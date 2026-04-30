-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "CloudProvider" AS ENUM ('AWS', 'OCI');

-- CreateEnum
CREATE TYPE "CloudAccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'MANUAL_COMPLETED');

-- CreateEnum
CREATE TYPE "RecommendationSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RecommendationDecisionType" AS ENUM ('APPROVED', 'REJECTED', 'MARKED_DONE');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "jwt_id" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_accounts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_region" TEXT,
    "status" "CloudAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cloud_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_credentials" (
    "id" TEXT NOT NULL,
    "cloud_account_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "encryption_iv" TEXT NOT NULL,
    "encryption_auth_tag" TEXT NOT NULL,
    "encryption_algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "encryption_key_version" TEXT NOT NULL DEFAULT 'v1',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "cloud_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_account_id" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "target_date" DATE NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "status" "IngestionStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "metrics_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_metrics" (
    "tenant_id" TEXT NOT NULL,
    "cloud_account_id" TEXT NOT NULL,
    "ingestion_run_id" TEXT,
    "provider" "CloudProvider" NOT NULL,
    "billing_account_id" TEXT,
    "billing_account_name" TEXT,
    "sub_account_id" TEXT,
    "sub_account_name" TEXT,
    "service_name" TEXT NOT NULL,
    "service_category" TEXT,
    "resource_id" TEXT NOT NULL DEFAULT '',
    "resource_name" TEXT,
    "resource_type" TEXT,
    "region_id" TEXT,
    "region_name" TEXT,
    "availability_zone" TEXT,
    "charge_category" TEXT NOT NULL DEFAULT 'Usage',
    "charge_class" TEXT,
    "charge_frequency" TEXT,
    "charge_period_start" TIMESTAMPTZ(6) NOT NULL,
    "charge_period_end" TIMESTAMPTZ(6) NOT NULL,
    "billing_period_start" TIMESTAMPTZ(6),
    "billing_period_end" TIMESTAMPTZ(6),
    "billed_cost" DECIMAL(18,6) NOT NULL,
    "effective_cost" DECIMAL(18,6),
    "list_cost" DECIMAL(18,6),
    "contracted_cost" DECIMAL(18,6),
    "billing_currency" VARCHAR(3) NOT NULL,
    "pricing_currency" VARCHAR(3),
    "consumed_quantity" DECIMAL(24,9),
    "consumed_unit" TEXT,
    "pricing_quantity" DECIMAL(24,9),
    "pricing_unit" TEXT,
    "source_metric" TEXT NOT NULL DEFAULT 'UnblendedCost',
    "metric_identity_hash" TEXT NOT NULL,
    "tags" JSONB,
    "provider_raw" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_metrics_pkey" PRIMARY KEY ("charge_period_start","metric_identity_hash")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_account_id" TEXT NOT NULL,
    "source_charge_period_start" TIMESTAMPTZ(6),
    "source_metric_identity_hash" TEXT,
    "type" TEXT NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PENDING',
    "severity" "RecommendationSeverity" NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB,
    "estimated_monthly_savings" DECIMAL(18,6),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_decisions" (
    "id" TEXT NOT NULL,
    "recommendation_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "decision" "RecommendationDecisionType" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendation_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenant_id_role_idx" ON "users"("tenant_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_jwt_id_key" ON "auth_sessions"("jwt_id");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_expires_at_idx" ON "auth_sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "cloud_accounts_tenant_id_status_idx" ON "cloud_accounts"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_accounts_tenant_id_provider_external_account_id_key" ON "cloud_accounts"("tenant_id", "provider", "external_account_id");

-- CreateIndex
CREATE INDEX "cloud_credentials_cloud_account_id_disabled_at_idx" ON "cloud_credentials"("cloud_account_id", "disabled_at");

-- CreateIndex
CREATE INDEX "ingestion_runs_tenant_id_target_date_idx" ON "ingestion_runs"("tenant_id", "target_date");

-- CreateIndex
CREATE INDEX "ingestion_runs_cloud_account_id_started_at_idx" ON "ingestion_runs"("cloud_account_id", "started_at");

-- CreateIndex
CREATE INDEX "cost_metrics_tenant_id_cloud_account_id_charge_period_start_idx" ON "cost_metrics"("tenant_id", "cloud_account_id", "charge_period_start");

-- CreateIndex
CREATE INDEX "cost_metrics_tenant_id_service_name_charge_period_start_idx" ON "cost_metrics"("tenant_id", "service_name", "charge_period_start");

-- CreateIndex
CREATE INDEX "cost_metrics_tenant_id_provider_charge_period_start_idx" ON "cost_metrics"("tenant_id", "provider", "charge_period_start");

-- CreateIndex
CREATE INDEX "cost_metrics_resource_id_idx" ON "cost_metrics"("resource_id");

-- CreateIndex
CREATE INDEX "recommendations_tenant_id_status_created_at_idx" ON "recommendations"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "recommendations_cloud_account_id_severity_idx" ON "recommendations"("cloud_account_id", "severity");

-- CreateIndex
CREATE INDEX "recommendations_source_charge_period_start_source_metric_id_idx" ON "recommendations"("source_charge_period_start", "source_metric_identity_hash");

-- CreateIndex
CREATE INDEX "recommendation_decisions_recommendation_id_created_at_idx" ON "recommendation_decisions"("recommendation_id", "created_at");

-- CreateIndex
CREATE INDEX "recommendation_decisions_user_id_created_at_idx" ON "recommendation_decisions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_created_at_idx" ON "audit_events"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_created_at_idx" ON "audit_events"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_accounts" ADD CONSTRAINT "cloud_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_credentials" ADD CONSTRAINT "cloud_credentials_cloud_account_id_fkey" FOREIGN KEY ("cloud_account_id") REFERENCES "cloud_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_cloud_account_id_fkey" FOREIGN KEY ("cloud_account_id") REFERENCES "cloud_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_metrics" ADD CONSTRAINT "cost_metrics_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_metrics" ADD CONSTRAINT "cost_metrics_cloud_account_id_fkey" FOREIGN KEY ("cloud_account_id") REFERENCES "cloud_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_metrics" ADD CONSTRAINT "cost_metrics_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_cloud_account_id_fkey" FOREIGN KEY ("cloud_account_id") REFERENCES "cloud_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_decisions" ADD CONSTRAINT "recommendation_decisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

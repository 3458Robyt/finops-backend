-- CreateEnum
CREATE TYPE "TenantAccessRole" AS ENUM ('TECHNICIAN', 'LEAD_TECHNICIAN', 'OPERATOR_ADMIN');

-- CreateEnum
CREATE TYPE "ProviderCapability" AS ENUM ('FOCUS_EXPORT', 'CROSS_ACCOUNT_DELIVERY', 'INVENTORY', 'TECHNICAL_METRICS', 'OPTIONAL_AGENTS');

-- CreateEnum
CREATE TYPE "CredentialPurpose" AS ENUM ('TEMPORARY_ADMIN', 'OPERATIONAL', 'BILLING_EXPORT_READ', 'INVENTORY_READ', 'METRICS_READ', 'STORAGE_READ', 'STORAGE_WRITE');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "IngestionJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IngestionSourceType" AS ENUM ('BILLING_EXPORT', 'INVENTORY', 'TECHNICAL_METRIC', 'AGENT_METRIC');

-- CreateEnum
CREATE TYPE "DataQualityStatus" AS ENUM ('PASSED', 'WARNING', 'FAILED');

-- CreateEnum
CREATE TYPE "CloudResourceStatus" AS ENUM ('ACTIVE', 'STOPPED', 'TERMINATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AgentInstallationStatus" AS ENUM ('NOT_INSTALLED', 'INSTALLED', 'DISABLED', 'UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CloudProvider" ADD VALUE 'AZURE';
ALTER TYPE "CloudProvider" ADD VALUE 'GCP';
ALTER TYPE "CloudProvider" ADD VALUE 'CUSTOM';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'OPERATOR_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'FINOPS_TECHNICIAN';
ALTER TYPE "UserRole" ADD VALUE 'CLIENT_APPROVER';
ALTER TYPE "UserRole" ADD VALUE 'CLIENT_VIEWER';

-- AlterTable
ALTER TABLE "ingestion_runs" ADD COLUMN     "cloud_connection_id" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "operator_organization_id" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "operator_organization_id" TEXT;

-- CreateTable
CREATE TABLE "operator_organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operator_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_access_assignments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "TenantAccessRole" NOT NULL DEFAULT 'TECHNICIAN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_access_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_catalog" (
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "capabilities" "ProviderCapability"[],
    "default_focus_version" TEXT,
    "documentation_url" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_catalog_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "cloud_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider_code" TEXT NOT NULL,
    "root_external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CloudAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "default_region" TEXT,
    "metadata" JSONB,
    "last_validated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cloud_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_connection_credentials" (
    "id" TEXT NOT NULL,
    "cloud_connection_id" TEXT NOT NULL,
    "purpose" "CredentialPurpose" NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "label" TEXT NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "encryption_iv" TEXT NOT NULL,
    "encryption_auth_tag" TEXT NOT NULL,
    "encryption_algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "encryption_key_version" TEXT NOT NULL DEFAULT 'v1',
    "external_principal_id" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "cloud_connection_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_storage_locations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 's3-compatible',
    "bucket_name" TEXT NOT NULL,
    "base_prefix" TEXT NOT NULL,
    "kms_key_ref" TEXT,
    "retention_days" INTEGER NOT NULL DEFAULT 730,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operator_storage_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_export_configs" (
    "id" TEXT NOT NULL,
    "cloud_connection_id" TEXT NOT NULL,
    "storage_location_id" TEXT,
    "source_type" "IngestionSourceType" NOT NULL DEFAULT 'BILLING_EXPORT',
    "focus_version" TEXT,
    "external_export_id" TEXT,
    "export_path" TEXT,
    "schedule" TEXT NOT NULL DEFAULT 'daily',
    "status" "CloudAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cloud_export_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_connection_id" TEXT NOT NULL,
    "source_type" "IngestionSourceType" NOT NULL,
    "status" "IngestionJobStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_user_id" TEXT,
    "target_start" TIMESTAMPTZ(6) NOT NULL,
    "target_end" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ingestion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_objects" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_connection_id" TEXT NOT NULL,
    "export_config_id" TEXT,
    "source_type" "IngestionSourceType" NOT NULL,
    "object_uri" TEXT NOT NULL,
    "object_etag" TEXT,
    "object_version" TEXT,
    "content_hash" TEXT,
    "status" "IngestionJobStatus" NOT NULL DEFAULT 'PENDING',
    "rows_processed" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "error_message" TEXT,

    CONSTRAINT "ingestion_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_watermarks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_connection_id" TEXT NOT NULL,
    "source_type" "IngestionSourceType" NOT NULL,
    "watermark_start" TIMESTAMPTZ(6),
    "watermark_end" TIMESTAMPTZ(6),
    "last_successful_run_at" TIMESTAMPTZ(6),
    "freshness_deadline_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ingestion_watermarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "focus_cost_line_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_connection_id" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "focus_version" TEXT NOT NULL,
    "charge_period_start" TIMESTAMPTZ(6) NOT NULL,
    "charge_period_end" TIMESTAMPTZ(6) NOT NULL,
    "billing_period_start" TIMESTAMPTZ(6),
    "billing_period_end" TIMESTAMPTZ(6),
    "billing_account_id" TEXT,
    "sub_account_id" TEXT,
    "service_name" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL DEFAULT '',
    "region_id" TEXT,
    "charge_category" TEXT NOT NULL DEFAULT 'Usage',
    "billed_cost" DECIMAL(18,6) NOT NULL,
    "effective_cost" DECIMAL(18,6),
    "list_cost" DECIMAL(18,6),
    "contracted_cost" DECIMAL(18,6),
    "billing_currency" VARCHAR(3) NOT NULL,
    "consumed_quantity" DECIMAL(24,9),
    "consumed_unit" TEXT,
    "tags" JSONB,
    "raw_row" JSONB NOT NULL,
    "line_item_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "focus_cost_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_resources" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_connection_id" TEXT NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "external_resource_id" TEXT NOT NULL,
    "name" TEXT,
    "resource_type" TEXT NOT NULL,
    "service_name" TEXT NOT NULL,
    "region_id" TEXT,
    "status" "CloudResourceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "tags" JSONB,
    "raw_resource" JSONB,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cloud_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_metric_samples" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_connection_id" TEXT NOT NULL,
    "cloud_resource_id" TEXT,
    "provider" "CloudProvider" NOT NULL,
    "external_resource_id" TEXT NOT NULL,
    "metric_name" TEXT NOT NULL,
    "metric_unit" TEXT,
    "value" DECIMAL(24,9) NOT NULL,
    "sampled_at" TIMESTAMPTZ(6) NOT NULL,
    "granularity_seconds" INTEGER NOT NULL DEFAULT 1800,
    "source_type" "IngestionSourceType" NOT NULL DEFAULT 'TECHNICAL_METRIC',
    "raw_metric" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_metric_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_installations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_connection_id" TEXT NOT NULL,
    "cloud_resource_id" TEXT,
    "external_resource_id" TEXT NOT NULL,
    "agent_type" TEXT NOT NULL,
    "status" "AgentInstallationStatus" NOT NULL DEFAULT 'UNKNOWN',
    "installed_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6),
    "metadata" JSONB,

    CONSTRAINT "agent_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_quality_checks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "cloud_connection_id" TEXT,
    "created_by_user_id" TEXT,
    "source_type" "IngestionSourceType" NOT NULL,
    "check_name" TEXT NOT NULL,
    "status" "DataQualityStatus" NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_at" TIMESTAMPTZ(6),
    "details" JSONB,

    CONSTRAINT "data_quality_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operator_organizations_slug_key" ON "operator_organizations"("slug");

-- CreateIndex
CREATE INDEX "tenant_access_assignments_user_id_disabled_at_idx" ON "tenant_access_assignments"("user_id", "disabled_at");

-- CreateIndex
CREATE INDEX "tenant_access_assignments_tenant_id_role_idx" ON "tenant_access_assignments"("tenant_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_access_assignments_tenant_id_user_id_key" ON "tenant_access_assignments"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "provider_catalog_provider_enabled_idx" ON "provider_catalog"("provider", "enabled");

-- CreateIndex
CREATE INDEX "cloud_connections_tenant_id_status_idx" ON "cloud_connections"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "cloud_connections_provider_code_status_idx" ON "cloud_connections"("provider_code", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_connections_tenant_id_provider_code_root_external_id_key" ON "cloud_connections"("tenant_id", "provider_code", "root_external_id");

-- CreateIndex
CREATE INDEX "cloud_connection_credentials_cloud_connection_id_purpose_st_idx" ON "cloud_connection_credentials"("cloud_connection_id", "purpose", "status");

-- CreateIndex
CREATE INDEX "cloud_connection_credentials_expires_at_idx" ON "cloud_connection_credentials"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "operator_storage_locations_tenant_id_bucket_name_key" ON "operator_storage_locations"("tenant_id", "bucket_name");

-- CreateIndex
CREATE INDEX "cloud_export_configs_cloud_connection_id_source_type_status_idx" ON "cloud_export_configs"("cloud_connection_id", "source_type", "status");

-- CreateIndex
CREATE INDEX "ingestion_jobs_status_source_type_created_at_idx" ON "ingestion_jobs"("status", "source_type", "created_at");

-- CreateIndex
CREATE INDEX "ingestion_jobs_tenant_id_cloud_connection_id_source_type_idx" ON "ingestion_jobs"("tenant_id", "cloud_connection_id", "source_type");

-- CreateIndex
CREATE INDEX "ingestion_objects_tenant_id_source_type_status_idx" ON "ingestion_objects"("tenant_id", "source_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_objects_cloud_connection_id_object_uri_object_eta_key" ON "ingestion_objects"("cloud_connection_id", "object_uri", "object_etag");

-- CreateIndex
CREATE INDEX "ingestion_watermarks_tenant_id_source_type_idx" ON "ingestion_watermarks"("tenant_id", "source_type");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_watermarks_cloud_connection_id_source_type_key" ON "ingestion_watermarks"("cloud_connection_id", "source_type");

-- CreateIndex
CREATE INDEX "focus_cost_line_items_tenant_id_provider_charge_period_star_idx" ON "focus_cost_line_items"("tenant_id", "provider", "charge_period_start");

-- CreateIndex
CREATE INDEX "focus_cost_line_items_tenant_id_service_name_charge_period__idx" ON "focus_cost_line_items"("tenant_id", "service_name", "charge_period_start");

-- CreateIndex
CREATE INDEX "focus_cost_line_items_resource_id_idx" ON "focus_cost_line_items"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "focus_cost_line_items_cloud_connection_id_charge_period_sta_key" ON "focus_cost_line_items"("cloud_connection_id", "charge_period_start", "line_item_hash");

-- CreateIndex
CREATE INDEX "cloud_resources_tenant_id_provider_resource_type_idx" ON "cloud_resources"("tenant_id", "provider", "resource_type");

-- CreateIndex
CREATE INDEX "cloud_resources_tenant_id_status_idx" ON "cloud_resources"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_resources_cloud_connection_id_external_resource_id_key" ON "cloud_resources"("cloud_connection_id", "external_resource_id");

-- CreateIndex
CREATE INDEX "resource_metric_samples_tenant_id_metric_name_sampled_at_idx" ON "resource_metric_samples"("tenant_id", "metric_name", "sampled_at");

-- CreateIndex
CREATE INDEX "resource_metric_samples_cloud_resource_id_sampled_at_idx" ON "resource_metric_samples"("cloud_resource_id", "sampled_at");

-- CreateIndex
CREATE UNIQUE INDEX "resource_metric_samples_cloud_connection_id_external_resour_key" ON "resource_metric_samples"("cloud_connection_id", "external_resource_id", "metric_name", "sampled_at");

-- CreateIndex
CREATE INDEX "agent_installations_tenant_id_status_idx" ON "agent_installations"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_installations_cloud_connection_id_external_resource_i_key" ON "agent_installations"("cloud_connection_id", "external_resource_id", "agent_type");

-- CreateIndex
CREATE INDEX "data_quality_checks_tenant_id_source_type_status_observed_a_idx" ON "data_quality_checks"("tenant_id", "source_type", "status", "observed_at");

-- CreateIndex
CREATE INDEX "data_quality_checks_cloud_connection_id_observed_at_idx" ON "data_quality_checks"("cloud_connection_id", "observed_at");

-- CreateIndex
CREATE INDEX "ingestion_runs_cloud_connection_id_started_at_idx" ON "ingestion_runs"("cloud_connection_id", "started_at");

-- CreateIndex
CREATE INDEX "tenants_operator_organization_id_status_idx" ON "tenants"("operator_organization_id", "status");

-- CreateIndex
CREATE INDEX "users_operator_organization_id_role_idx" ON "users"("operator_organization_id", "role");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_operator_organization_id_fkey" FOREIGN KEY ("operator_organization_id") REFERENCES "operator_organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_operator_organization_id_fkey" FOREIGN KEY ("operator_organization_id") REFERENCES "operator_organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_access_assignments" ADD CONSTRAINT "tenant_access_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_access_assignments" ADD CONSTRAINT "tenant_access_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_connections" ADD CONSTRAINT "cloud_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_connections" ADD CONSTRAINT "cloud_connections_provider_code_fkey" FOREIGN KEY ("provider_code") REFERENCES "provider_catalog"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_connection_credentials" ADD CONSTRAINT "cloud_connection_credentials_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_storage_locations" ADD CONSTRAINT "operator_storage_locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_export_configs" ADD CONSTRAINT "cloud_export_configs_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_export_configs" ADD CONSTRAINT "cloud_export_configs_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "operator_storage_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_objects" ADD CONSTRAINT "ingestion_objects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_objects" ADD CONSTRAINT "ingestion_objects_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_objects" ADD CONSTRAINT "ingestion_objects_export_config_id_fkey" FOREIGN KEY ("export_config_id") REFERENCES "cloud_export_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_watermarks" ADD CONSTRAINT "ingestion_watermarks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_watermarks" ADD CONSTRAINT "ingestion_watermarks_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "focus_cost_line_items" ADD CONSTRAINT "focus_cost_line_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "focus_cost_line_items" ADD CONSTRAINT "focus_cost_line_items_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_resources" ADD CONSTRAINT "cloud_resources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_resources" ADD CONSTRAINT "cloud_resources_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_metric_samples" ADD CONSTRAINT "resource_metric_samples_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_metric_samples" ADD CONSTRAINT "resource_metric_samples_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_metric_samples" ADD CONSTRAINT "resource_metric_samples_cloud_resource_id_fkey" FOREIGN KEY ("cloud_resource_id") REFERENCES "cloud_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_installations" ADD CONSTRAINT "agent_installations_cloud_resource_id_fkey" FOREIGN KEY ("cloud_resource_id") REFERENCES "cloud_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_quality_checks" ADD CONSTRAINT "data_quality_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_quality_checks" ADD CONSTRAINT "data_quality_checks_cloud_connection_id_fkey" FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_quality_checks" ADD CONSTRAINT "data_quality_checks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "recommendation_execution_plans_generated_by_user_id_created_at_" RENAME TO "recommendation_execution_plans_generated_by_user_id_created_idx";

-- Seed first-wave provider catalog entries.
INSERT INTO "provider_catalog" (
    "code",
    "display_name",
    "provider",
    "capabilities",
    "default_focus_version",
    "documentation_url",
    "updated_at"
) VALUES
    (
        'aws',
        'Amazon Web Services',
        'AWS',
        ARRAY['FOCUS_EXPORT', 'CROSS_ACCOUNT_DELIVERY', 'INVENTORY', 'TECHNICAL_METRICS', 'OPTIONAL_AGENTS']::"ProviderCapability"[],
        '1.2',
        'https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create.html',
        CURRENT_TIMESTAMP
    ),
    (
        'oci',
        'Oracle Cloud Infrastructure',
        'OCI',
        ARRAY['FOCUS_EXPORT', 'INVENTORY', 'TECHNICAL_METRICS', 'OPTIONAL_AGENTS']::"ProviderCapability"[],
        '1.0',
        'https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/costusagereportsoverview.htm',
        CURRENT_TIMESTAMP
    )
ON CONFLICT ("code") DO UPDATE SET
    "display_name" = EXCLUDED."display_name",
    "provider" = EXCLUDED."provider",
    "capabilities" = EXCLUDED."capabilities",
    "default_focus_version" = EXCLUDED."default_focus_version",
    "documentation_url" = EXCLUDED."documentation_url",
    "enabled" = true,
    "updated_at" = CURRENT_TIMESTAMP;

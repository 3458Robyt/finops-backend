CREATE TYPE "CostAllocationRuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

CREATE TABLE "cost_allocation_rules" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 100,
  "status" "CostAllocationRuleStatus" NOT NULL DEFAULT 'DRAFT',
  "cloud_account_id" TEXT,
  "provider" "CloudProvider",
  "service_name" TEXT,
  "region_id" TEXT,
  "resource_id" TEXT,
  "tag_key" TEXT,
  "tag_value" TEXT,
  "cost_center" TEXT,
  "business_unit" TEXT,
  "project" TEXT,
  "team" TEXT,
  "environment" TEXT,
  "effective_from" TIMESTAMPTZ(6),
  "effective_to" TIMESTAMPTZ(6),
  "created_by_user_id" TEXT NOT NULL,
  "archived_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "cost_allocation_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cost_allocation_rules_effective_range" CHECK ("effective_to" IS NULL OR "effective_from" IS NULL OR "effective_from" <= "effective_to")
);

CREATE INDEX "cost_allocation_rules_tenant_id_status_priority_idx" ON "cost_allocation_rules"("tenant_id", "status", "priority");
CREATE INDEX "cost_allocation_rules_tenant_id_cloud_account_id_service_name_idx" ON "cost_allocation_rules"("tenant_id", "cloud_account_id", "service_name");
ALTER TABLE "cost_allocation_rules" ADD CONSTRAINT "cost_allocation_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cost_allocation_rules" ADD CONSTRAINT "cost_allocation_rules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

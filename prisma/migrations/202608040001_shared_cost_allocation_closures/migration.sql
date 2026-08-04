-- Add auditable shared-cost distribution and immutable period closures.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type AS t
    JOIN pg_namespace AS n ON n.oid = t.typnamespace
    WHERE t.typname = 'CostAllocationMode'
      AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "CostAllocationMode" AS ENUM ('DIRECT', 'SPLIT');
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type AS t
    JOIN pg_namespace AS n ON n.oid = t.typnamespace
    WHERE t.typname = 'CostAllocationClosureStatus'
      AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "CostAllocationClosureStatus" AS ENUM ('CLOSED', 'REPLACED');
  END IF;
END
$$;

ALTER TABLE "cost_allocation_rules"
  ADD COLUMN IF NOT EXISTS "allocation_mode" "CostAllocationMode" NOT NULL DEFAULT 'DIRECT',
  ADD COLUMN IF NOT EXISTS "configuration_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "configuration_hash" VARCHAR(64);

ALTER TABLE "cost_allocation_rules"
  ADD CONSTRAINT "cost_allocation_rules_id_tenant_id_key" UNIQUE ("id", "tenant_id");

CREATE TABLE "cost_allocation_rule_targets" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "rule_id" TEXT NOT NULL,
  "percentage" DECIMAL(7,4) NOT NULL,
  "cost_center" TEXT,
  "business_unit" TEXT,
  "project" TEXT,
  "team" TEXT,
  "environment" TEXT,
  CONSTRAINT "cost_allocation_rule_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cost_allocation_rule_targets_percentage_check" CHECK ("percentage" > 0 AND "percentage" <= 100),
  CONSTRAINT "cost_allocation_rule_targets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cost_allocation_rule_targets_rule_id_tenant_id_fkey" FOREIGN KEY ("rule_id", "tenant_id") REFERENCES "cost_allocation_rules"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "cost_allocation_rule_targets_tenant_id_rule_id_idx"
  ON "cost_allocation_rule_targets"("tenant_id", "rule_id");

CREATE TABLE "cost_allocation_closures" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "period_start" TIMESTAMPTZ(6) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "CostAllocationClosureStatus" NOT NULL DEFAULT 'CLOSED',
  "source_total" DECIMAL(18,6) NOT NULL,
  "allocated_total" DECIMAL(18,6) NOT NULL,
  "shared_total" DECIMAL(18,6) NOT NULL,
  "unallocated_total" DECIMAL(18,6) NOT NULL,
  "source_hash" VARCHAR(64) NOT NULL,
  "rules_hash" VARCHAR(64) NOT NULL,
  "results" JSONB NOT NULL,
  "replacement_reason" TEXT,
  "closed_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cost_allocation_closures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cost_allocation_closures_version_check" CHECK ("version" > 0),
  CONSTRAINT "cost_allocation_closures_currency_check" CHECK (char_length("currency") = 3),
  CONSTRAINT "cost_allocation_closures_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cost_allocation_closures_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "cost_allocation_closures_tenant_period_currency_version_key"
  ON "cost_allocation_closures"("tenant_id", "period_start", "currency", "version");
CREATE INDEX "cost_allocation_closures_tenant_period_status_idx"
  ON "cost_allocation_closures"("tenant_id", "period_start", "status");
CREATE INDEX "cost_allocation_closures_tenant_source_hash_idx"
  ON "cost_allocation_closures"("tenant_id", "source_hash");

ALTER TABLE "cost_allocation_rule_targets" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finops_tenant_isolation ON "cost_allocation_rule_targets";
CREATE POLICY finops_tenant_isolation ON "cost_allocation_rule_targets"
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());

ALTER TABLE "cost_allocation_closures" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finops_tenant_isolation ON "cost_allocation_closures";
CREATE POLICY finops_tenant_isolation ON "cost_allocation_closures"
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());

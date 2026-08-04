-- Persist the line-level evidence used by each financial closure.
-- This is additive: existing closure aggregates remain immutable and valid.
UPDATE "cost_allocation_rules" r
SET "configuration_hash" = md5(concat_ws('|',
  r."id", r."tenant_id", r."name", r."priority", r."status"::text,
  r."allocation_mode"::text, r."cloud_account_id", r."provider"::text,
  r."service_name", r."region_id", r."resource_id", r."tag_key", r."tag_value",
  r."cost_center", r."business_unit", r."project", r."team", r."environment",
  r."effective_from", r."effective_to",
  COALESCE((SELECT string_agg(concat_ws(':', t."percentage", t."cost_center", t."business_unit", t."project", t."team", t."environment"), ',' ORDER BY t."id")
            FROM "cost_allocation_rule_targets" t WHERE t."tenant_id" = r."tenant_id" AND t."rule_id" = r."id"), '')
))
WHERE r."configuration_hash" IS NULL;

CREATE TABLE "cost_allocation_closure_lines" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "closure_id" TEXT NOT NULL,
  "charge_period_start" TIMESTAMPTZ(6) NOT NULL,
  "metric_identity_hash" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "source_amount" DECIMAL(18,6) NOT NULL,
  "allocation_amount" DECIMAL(18,6) NOT NULL,
  "allocation_key" TEXT NOT NULL,
  "allocation_mode" "CostAllocationMode" NOT NULL,
  "shared" BOOLEAN NOT NULL DEFAULT false,
  "percentage" DECIMAL(7,4),
  "rule_id" TEXT,
  "cloud_account_id" TEXT NOT NULL,
  "provider" "CloudProvider" NOT NULL,
  "service_name" TEXT NOT NULL,
  "region_id" TEXT,
  "resource_id" TEXT,
  "cloud_resource_id" TEXT,
  "resource_link_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cost_allocation_closure_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cost_allocation_closure_lines_currency_check" CHECK (char_length("currency") = 3),
  CONSTRAINT "cost_allocation_closure_lines_source_amount_check" CHECK ("source_amount" >= 0),
  CONSTRAINT "cost_allocation_closure_lines_allocation_amount_check" CHECK ("allocation_amount" >= 0),
  CONSTRAINT "cost_allocation_closure_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cost_allocation_closure_lines_closure_id_fkey" FOREIGN KEY ("closure_id") REFERENCES "cost_allocation_closures"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "cost_allocation_closure_lines_identity_key"
  ON "cost_allocation_closure_lines"("closure_id", "charge_period_start", "metric_identity_hash", "allocation_key");
CREATE INDEX "cost_allocation_closure_lines_tenant_closure_destination_idx"
  ON "cost_allocation_closure_lines"("tenant_id", "closure_id", "allocation_key", "currency");
CREATE INDEX "cost_allocation_closure_lines_tenant_resource_period_idx"
  ON "cost_allocation_closure_lines"("tenant_id", "currency", "cloud_resource_id", "charge_period_start");
CREATE INDEX "cost_allocation_closure_lines_tenant_metric_period_idx"
  ON "cost_allocation_closure_lines"("tenant_id", "currency", "metric_identity_hash", "charge_period_start");

ALTER TABLE "cost_allocation_closure_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finops_tenant_isolation ON "cost_allocation_closure_lines";
CREATE POLICY finops_tenant_isolation ON "cost_allocation_closure_lines"
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());

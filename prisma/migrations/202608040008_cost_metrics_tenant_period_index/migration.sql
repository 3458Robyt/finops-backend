-- Allocation preview and closure always filter cost metrics by tenant and billing period.
-- This leading index avoids scanning the full cost_metrics table when no secondary
-- account/service/resource filter is supplied.
CREATE INDEX IF NOT EXISTS "cost_metrics_tenant_period_idx"
  ON "cost_metrics" ("tenant_id", "charge_period_start");

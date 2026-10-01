-- Supports the lightweight latest-observed-through lookup used by AI analysis.
CREATE INDEX IF NOT EXISTS "cost_metrics_tenant_period_end_idx"
  ON "cost_metrics" ("tenant_id", "charge_period_end" DESC);

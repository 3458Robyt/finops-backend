CREATE INDEX IF NOT EXISTS "cloud_resources_tenant_last_seen_at_idx"
  ON "cloud_resources"("tenant_id", "last_seen_at", "id");

CREATE INDEX IF NOT EXISTS "cost_metrics_tenant_connection_period_end_idx"
  ON "cost_metrics"("tenant_id", "cloud_connection_id", "charge_period_end");

CREATE INDEX IF NOT EXISTS "resource_metric_samples_tenant_connection_sampled_at_idx"
  ON "resource_metric_samples"("tenant_id", "cloud_connection_id", "sampled_at");

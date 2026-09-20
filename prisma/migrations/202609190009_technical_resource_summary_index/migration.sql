-- Supports canonical resource detail summaries without scanning other streams
-- that share the same provider external identifier.
CREATE INDEX IF NOT EXISTS "resource_metric_samples_tenant_cloud_resource_external_idx"
  ON "resource_metric_samples" (
    "tenant_id",
    "cloud_resource_id",
    "external_resource_id",
    "metric_name",
    "statistic",
    "sampled_at"
  );

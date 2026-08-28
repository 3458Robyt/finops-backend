-- The UI always filters a selected metric/statistic. Put those equality
-- predicates before the time/order columns so PostgreSQL does not scan every
-- rollup in a tenant bucket and discard unrelated metrics.
CREATE INDEX IF NOT EXISTS "resource_metric_rollups_series_filter_idx"
  ON "resource_metric_rollups" (
    "tenant_id", "bucket_seconds", "metric_name", "statistic", "bucket_start",
    "external_resource_id", "cloud_resource_id", "provider_namespace",
    "region_id", "dimensions_hash"
  );

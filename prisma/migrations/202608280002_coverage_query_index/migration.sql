-- Supports bounded coverage audits and scheduler lookups by connection/configuration.
CREATE INDEX IF NOT EXISTS "resource_metric_coverage_windows_connection_config_idx"
  ON "resource_metric_coverage_windows" (
    "tenant_id", "cloud_connection_id", "configuration_hash",
    "granularity_seconds", "window_start", "status"
  );

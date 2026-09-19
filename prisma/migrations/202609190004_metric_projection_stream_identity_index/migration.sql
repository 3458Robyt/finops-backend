-- Accelerates idempotent technical rollup rebuilds by making the affected
-- stream identity searchable before the sampled_at range scan.
CREATE INDEX "resource_metric_samples_projection_stream_idx"
ON "resource_metric_samples" (
  "cloud_connection_id",
  "provider_namespace",
  "region_id",
  "external_resource_id",
  "metric_name",
  "statistic",
  "granularity_seconds",
  "dimensions_hash",
  "sampled_at"
)
WHERE "source_type" = 'TECHNICAL_METRIC'::"IngestionSourceType";

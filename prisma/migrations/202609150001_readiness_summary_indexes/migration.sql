-- Readiness uses stream summaries for large metric counts. Keep the raw
-- unresolved-reason lookup index small by indexing only rows that need it.
CREATE INDEX IF NOT EXISTS "resource_metric_samples_unresolved_reason_idx"
  ON "resource_metric_samples" ("tenant_id", "cloud_connection_id", "resource_link_reason")
  WHERE "cloud_resource_id" IS NULL AND "resource_link_reason" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "resource_metric_stream_summaries_tenant_resource_idx"
  ON "resource_metric_stream_summaries" ("tenant_id", "cloud_resource_id");

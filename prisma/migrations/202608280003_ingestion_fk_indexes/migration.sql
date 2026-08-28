-- Indexes the remaining public foreign keys reported by the Supabase advisor.
CREATE INDEX IF NOT EXISTS "ingestion_coverage_segments_ingestion_job_id_idx"
  ON "ingestion_coverage_segments" ("ingestion_job_id");

CREATE INDEX IF NOT EXISTS "resource_metric_coverage_windows_metric_definition_id_idx"
  ON "resource_metric_coverage_windows" ("cloud_metric_definition_id");

CREATE INDEX IF NOT EXISTS "resource_metric_rollups_cloud_resource_id_idx"
  ON "resource_metric_rollups" ("cloud_resource_id");

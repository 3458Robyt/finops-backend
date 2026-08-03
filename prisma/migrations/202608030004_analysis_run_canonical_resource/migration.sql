ALTER TABLE "recommendation_analysis_runs"
  ADD COLUMN IF NOT EXISTS "cloud_resource_id" TEXT;

CREATE INDEX IF NOT EXISTS "recommendation_analysis_runs_tenant_cloud_resource_created_at_idx"
  ON "recommendation_analysis_runs" ("tenant_id", "cloud_resource_id", "created_at");

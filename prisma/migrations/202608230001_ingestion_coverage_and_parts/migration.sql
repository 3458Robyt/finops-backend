-- Durable ingestion provenance and coverage ledger.
-- This migration is additive: existing application data remains valid and
-- historical rows receive NULL provenance until a new ingestion writes them.

ALTER TABLE "ingestion_objects"
  ADD COLUMN IF NOT EXISTS "ingestion_job_id" TEXT;

ALTER TABLE "focus_cost_line_items"
  ADD COLUMN IF NOT EXISTS "ingestion_job_id" TEXT,
  ADD COLUMN IF NOT EXISTS "source_object_uri" TEXT,
  ADD COLUMN IF NOT EXISTS "source_object_etag" TEXT;

ALTER TABLE "resource_metric_samples"
  ADD COLUMN IF NOT EXISTS "ingestion_job_id" TEXT;

CREATE TABLE IF NOT EXISTS "ingestion_job_parts" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cloud_connection_id" TEXT NOT NULL,
  "ingestion_job_id" TEXT NOT NULL,
  "part_key" TEXT NOT NULL,
  "source_type" "IngestionSourceType" NOT NULL,
  "status" "IngestionJobStatus" NOT NULL DEFAULT 'PENDING',
  "target_start" TIMESTAMPTZ(6) NOT NULL,
  "target_end" TIMESTAMPTZ(6) NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "api_calls" INTEGER NOT NULL DEFAULT 0,
  "rows_read" INTEGER NOT NULL DEFAULT 0,
  "rows_written" INTEGER NOT NULL DEFAULT 0,
  "samples_read" INTEGER NOT NULL DEFAULT 0,
  "samples_written" INTEGER NOT NULL DEFAULT 0,
  "cursor" TEXT,
  "metadata" JSONB,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ingestion_job_parts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ingestion_job_parts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ingestion_job_parts_cloud_connection_id_fkey"
    FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ingestion_job_parts_ingestion_job_id_fkey"
    FOREIGN KEY ("ingestion_job_id") REFERENCES "ingestion_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "ingestion_coverage_segments" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cloud_connection_id" TEXT NOT NULL,
  "ingestion_job_id" TEXT,
  "source_type" "IngestionSourceType" NOT NULL,
  "scope_key" TEXT NOT NULL DEFAULT 'global',
  "status" TEXT NOT NULL DEFAULT 'COVERED',
  "target_start" TIMESTAMPTZ(6) NOT NULL,
  "target_end" TIMESTAMPTZ(6) NOT NULL,
  "configuration_hash" VARCHAR(64),
  "rows_written" INTEGER NOT NULL DEFAULT 0,
  "samples_written" INTEGER NOT NULL DEFAULT 0,
  "objects_processed" INTEGER NOT NULL DEFAULT 0,
  "evidence" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ingestion_coverage_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ingestion_coverage_segments_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ingestion_coverage_segments_cloud_connection_id_fkey"
    FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ingestion_coverage_segments_ingestion_job_id_fkey"
    FOREIGN KEY ("ingestion_job_id") REFERENCES "ingestion_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ingestion_objects_ingestion_job_id_fkey'
  ) THEN
    ALTER TABLE "ingestion_objects"
      ADD CONSTRAINT "ingestion_objects_ingestion_job_id_fkey"
      FOREIGN KEY ("ingestion_job_id") REFERENCES "ingestion_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'focus_cost_line_items_ingestion_job_id_fkey'
  ) THEN
    ALTER TABLE "focus_cost_line_items"
      ADD CONSTRAINT "focus_cost_line_items_ingestion_job_id_fkey"
      FOREIGN KEY ("ingestion_job_id") REFERENCES "ingestion_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'resource_metric_samples_ingestion_job_id_fkey'
  ) THEN
    ALTER TABLE "resource_metric_samples"
      ADD CONSTRAINT "resource_metric_samples_ingestion_job_id_fkey"
      FOREIGN KEY ("ingestion_job_id") REFERENCES "ingestion_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_job_parts_job_part_key"
  ON "ingestion_job_parts" ("ingestion_job_id", "part_key");
CREATE INDEX IF NOT EXISTS "ingestion_job_parts_tenant_status_idx"
  ON "ingestion_job_parts" ("tenant_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "ingestion_job_parts_connection_window_idx"
  ON "ingestion_job_parts" ("cloud_connection_id", "source_type", "target_start", "target_end");
CREATE INDEX IF NOT EXISTS "ingestion_coverage_segments_window_idx"
  ON "ingestion_coverage_segments" ("cloud_connection_id", "source_type", "scope_key", "target_start", "target_end");
CREATE INDEX IF NOT EXISTS "ingestion_coverage_segments_tenant_status_idx"
  ON "ingestion_coverage_segments" ("tenant_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "ingestion_objects_ingestion_job_id_idx"
  ON "ingestion_objects" ("ingestion_job_id");
CREATE INDEX IF NOT EXISTS "focus_cost_line_items_ingestion_job_id_idx"
  ON "focus_cost_line_items" ("ingestion_job_id");
CREATE INDEX IF NOT EXISTS "resource_metric_samples_ingestion_job_id_idx"
  ON "resource_metric_samples" ("ingestion_job_id");

ALTER TABLE "ingestion_job_parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_coverage_segments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "finops_ingestion_job_parts_tenant_isolation" ON "ingestion_job_parts";
DROP POLICY IF EXISTS "finops_ingestion_coverage_segments_tenant_isolation" ON "ingestion_coverage_segments";
CREATE POLICY "finops_ingestion_job_parts_tenant_isolation"
  ON "ingestion_job_parts" FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());
CREATE POLICY "finops_ingestion_coverage_segments_tenant_isolation"
  ON "ingestion_coverage_segments" FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());

GRANT USAGE ON SCHEMA public TO finops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ingestion_job_parts", "ingestion_coverage_segments" TO finops_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO finops_runtime;

-- P0/P1 ingestion reliability primitives.
-- This migration is additive and intentionally does not delete raw data.

DO $$
BEGIN
  CREATE TYPE "MetricProjectionStatus" AS ENUM (
    'NOT_REQUIRED', 'PENDING', 'RUNNING', 'SUCCESS', 'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "MetricCoverageStatus" AS ENUM (
    'UNKNOWN', 'COVERED', 'PARTIAL', 'NO_DATA', 'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ingestion_jobs"
  ADD COLUMN IF NOT EXISTS "projection_status" "MetricProjectionStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN IF NOT EXISTS "projection_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "projection_max_attempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "projection_available_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "projection_locked_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "projection_locked_by" TEXT,
  ADD COLUMN IF NOT EXISTS "projection_started_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "projection_completed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "projection_error_message" TEXT;

CREATE INDEX IF NOT EXISTS "ingestion_jobs_projection_queue_idx"
  ON "ingestion_jobs" ("projection_status", "projection_available_at", "projection_attempts");

CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_jobs_active_window_unique_idx"
  ON "ingestion_jobs" (
    "cloud_connection_id",
    "source_type",
    COALESCE("configuration_hash", ''),
    "target_start",
    "target_end"
  )
  WHERE "archived_at" IS NULL AND "status" IN ('PENDING', 'RUNNING');

CREATE TABLE IF NOT EXISTS "resource_metric_coverage_windows" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cloud_connection_id" TEXT NOT NULL,
  "cloud_metric_definition_id" TEXT,
  "ingestion_job_id" TEXT,
  "stream_key" VARCHAR(128) NOT NULL,
  "provider_namespace" TEXT NOT NULL DEFAULT '',
  "region_id" TEXT NOT NULL DEFAULT '',
  "external_resource_id" TEXT NOT NULL,
  "metric_name" TEXT NOT NULL,
  "statistic" "MetricStatistic" NOT NULL,
  "granularity_seconds" INTEGER NOT NULL,
  "window_start" TIMESTAMPTZ(6) NOT NULL,
  "window_end" TIMESTAMPTZ(6) NOT NULL,
  "status" "MetricCoverageStatus" NOT NULL DEFAULT 'UNKNOWN',
  "expected_samples" INTEGER NOT NULL DEFAULT 0,
  "observed_samples" INTEGER NOT NULL DEFAULT 0,
  "missing_samples" INTEGER NOT NULL DEFAULT 0,
  "configuration_hash" VARCHAR(64) NOT NULL DEFAULT '',
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "evidence" JSONB,
  "checked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resource_metric_coverage_windows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_metric_coverage_windows_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "resource_metric_coverage_windows_cloud_connection_id_fkey"
    FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "resource_metric_coverage_windows_metric_definition_id_fkey"
    FOREIGN KEY ("cloud_metric_definition_id") REFERENCES "cloud_metric_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "resource_metric_coverage_windows_ingestion_job_id_fkey"
    FOREIGN KEY ("ingestion_job_id") REFERENCES "ingestion_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "resource_metric_coverage_windows_identity_key"
  ON "resource_metric_coverage_windows" (
    "cloud_connection_id", "stream_key", "granularity_seconds",
    "window_start", "window_end", "configuration_hash"
  );
CREATE INDEX IF NOT EXISTS "resource_metric_coverage_windows_tenant_status_idx"
  ON "resource_metric_coverage_windows" ("tenant_id", "status", "window_start");
CREATE INDEX IF NOT EXISTS "resource_metric_coverage_windows_stream_idx"
  ON "resource_metric_coverage_windows" ("cloud_connection_id", "metric_name", "statistic", "window_start");
CREATE INDEX IF NOT EXISTS "resource_metric_coverage_windows_job_idx"
  ON "resource_metric_coverage_windows" ("ingestion_job_id");

ALTER TABLE "resource_metric_coverage_windows" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "finops_resource_metric_coverage_windows_tenant_isolation" ON "resource_metric_coverage_windows";
CREATE POLICY "finops_resource_metric_coverage_windows_tenant_isolation"
  ON "resource_metric_coverage_windows" FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "resource_metric_coverage_windows" TO finops_runtime;

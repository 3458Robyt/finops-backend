-- Enterprise ingestion truth columns and scoped uniqueness.
-- A provider request without rows must not advance a global checkpoint.

DO $$
BEGIN
  CREATE TYPE "IngestionDataOutcome" AS ENUM (
    'DATA_WRITTEN',
    'NO_DATA',
    'PARTIAL',
    'INVALID_CONFIGURATION',
    'PROVIDER_ERROR'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ingestion_jobs"
  ADD COLUMN IF NOT EXISTS "data_outcome" "IngestionDataOutcome";

ALTER TABLE "ingestion_watermarks"
  ADD COLUMN IF NOT EXISTS "scope_key" TEXT NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS "configuration_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "last_data_at" TIMESTAMPTZ(6);

DROP INDEX IF EXISTS "ingestion_watermarks_cloud_connection_id_source_type_key";
DROP INDEX IF EXISTS "ingestion_watermarks_connection_source_scope_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_watermarks_connection_source_scope_key"
  ON "ingestion_watermarks" ("cloud_connection_id", "source_type", "scope_key");
CREATE INDEX IF NOT EXISTS "ingestion_watermarks_tenant_source_scope_idx"
  ON "ingestion_watermarks" ("tenant_id", "source_type", "scope_key");

ALTER TABLE "resource_metric_samples"
  ADD COLUMN IF NOT EXISTS "provider_namespace" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "region_id" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "compartment_id" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "dimensions_hash" VARCHAR(64) NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "resource_metric_samples_cloud_connection_id_external_resour_key";
DROP INDEX IF EXISTS "resource_metric_samples_cloud_connection_id_external_resource_id_metric_name_statistic_granularity_seconds_sampled_at_key";
DROP INDEX IF EXISTS "resource_metric_samples_identity_key";
CREATE UNIQUE INDEX IF NOT EXISTS "resource_metric_samples_identity_key"
  ON "resource_metric_samples" (
    "cloud_connection_id",
    "provider_namespace",
    "region_id",
    "external_resource_id",
    "metric_name",
    "statistic",
    "granularity_seconds",
    "sampled_at",
    "dimensions_hash"
  );

CREATE INDEX IF NOT EXISTS "resource_metric_samples_tenant_connection_sampled_at_idx"
  ON "resource_metric_samples" ("tenant_id", "cloud_connection_id", "sampled_at");
CREATE INDEX IF NOT EXISTS "resource_metric_samples_tenant_provider_region_metric_idx"
  ON "resource_metric_samples" ("tenant_id", "provider_namespace", "region_id", "metric_name", "statistic", "sampled_at");

-- Peak-preserving PostgreSQL rollups for the technical-metrics read path.
-- The table is intentionally additive: raw samples remain the source of truth
-- and are still used for exact drill-down queries.
CREATE TABLE IF NOT EXISTS "resource_metric_rollups" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cloud_connection_id" TEXT NOT NULL,
  "cloud_resource_id" TEXT,
  "provider" "CloudProvider" NOT NULL,
  "external_resource_id" TEXT NOT NULL,
  "provider_namespace" TEXT NOT NULL DEFAULT '',
  "region_id" TEXT NOT NULL DEFAULT '',
  "compartment_id" TEXT NOT NULL DEFAULT '',
  "dimensions_hash" VARCHAR(64) NOT NULL DEFAULT '',
  "metric_name" TEXT NOT NULL,
  "metric_unit" TEXT,
  "statistic" "MetricStatistic" NOT NULL,
  "bucket_seconds" INTEGER NOT NULL,
  "bucket_start" TIMESTAMPTZ(6) NOT NULL,
  "sample_count" INTEGER NOT NULL,
  "sum_value" DECIMAL(24,9) NOT NULL,
  "avg_value" DECIMAL(24,9) NOT NULL,
  "min_value" DECIMAL(24,9) NOT NULL,
  "p50_value" DECIMAL(24,9),
  "p90_value" DECIMAL(24,9),
  "p95_value" DECIMAL(24,9),
  "p99_value" DECIMAL(24,9),
  "min_sampled_at" TIMESTAMPTZ(6) NOT NULL,
  "max_value" DECIMAL(24,9) NOT NULL,
  "max_sampled_at" TIMESTAMPTZ(6) NOT NULL,
  "latest_value" DECIMAL(24,9) NOT NULL,
  "latest_sampled_at" TIMESTAMPTZ(6) NOT NULL,
  "source_granularities" INTEGER[] NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resource_metric_rollups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_metric_rollups_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "resource_metric_rollups_connection_fkey"
    FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id") ON DELETE CASCADE,
  CONSTRAINT "resource_metric_rollups_resource_fkey"
    FOREIGN KEY ("cloud_resource_id") REFERENCES "cloud_resources"("id") ON DELETE SET NULL,
  CONSTRAINT "resource_metric_rollups_bucket_seconds_check"
    CHECK ("bucket_seconds" IN (1800, 3600, 86400))
);

CREATE UNIQUE INDEX IF NOT EXISTS "resource_metric_rollups_identity_key"
  ON "resource_metric_rollups" (
    "cloud_connection_id", "provider_namespace", "region_id",
    "external_resource_id", "metric_name", "statistic", "bucket_seconds",
    "bucket_start", "dimensions_hash"
  );

CREATE INDEX IF NOT EXISTS "resource_metric_rollups_tenant_bucket_idx"
  ON "resource_metric_rollups" ("tenant_id", "bucket_seconds", "bucket_start");

CREATE INDEX IF NOT EXISTS "resource_metric_rollups_tenant_metric_idx"
  ON "resource_metric_rollups" ("tenant_id", "metric_name", "statistic", "bucket_seconds", "bucket_start");

CREATE INDEX IF NOT EXISTS "resource_metric_rollups_tenant_resource_idx"
  ON "resource_metric_rollups" ("tenant_id", "external_resource_id", "metric_name", "statistic", "bucket_seconds", "bucket_start");

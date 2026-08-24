-- Preserve provider stream identity and maintain a cheap coverage projection.
ALTER TABLE "cloud_resources"
  ADD COLUMN IF NOT EXISTS "identity_source" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "identity_priority" INTEGER NOT NULL DEFAULT 0;

UPDATE "cloud_resources"
SET
  "identity_source" = COALESCE(NULLIF("raw_resource"->>'source', ''), 'UNKNOWN'),
  "identity_priority" = CASE COALESCE("raw_resource"->>'source', '')
    WHEN 'OCI_INVENTORY_METADATA' THEN 4
    WHEN 'AWS_INVENTORY_METADATA' THEN 4
    WHEN 'OCI_COMPUTE_SDK' THEN 3
    WHEN 'AWS_EC2_SDK' THEN 3
    WHEN 'OCI_RESOURCE_SEARCH' THEN 2
    WHEN 'OCI_METRIC_DEFINITION' THEN 1
    WHEN 'AWS_METRIC_DEFINITION' THEN 1
    ELSE 0
  END;

CREATE INDEX IF NOT EXISTS "cloud_resources_identity_priority_idx"
  ON "cloud_resources" ("cloud_connection_id", "identity_priority", "last_seen_at");

CREATE TABLE IF NOT EXISTS "resource_metric_stream_summaries" (
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
  "granularity_seconds" INTEGER NOT NULL,
  "sample_count" INTEGER NOT NULL DEFAULT 0,
  "non_zero_sample_count" INTEGER NOT NULL DEFAULT 0,
  "first_sampled_at" TIMESTAMPTZ(6),
  "last_sampled_at" TIMESTAMPTZ(6),
  "latest_value" DECIMAL(24,9),
  "state" TEXT NOT NULL DEFAULT 'NO_SAMPLES',
  "last_ingested_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resource_metric_stream_summaries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resource_metric_stream_summaries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "resource_metric_stream_summaries_connection_id_fkey"
    FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "resource_metric_stream_summaries_resource_id_fkey"
    FOREIGN KEY ("cloud_resource_id") REFERENCES "cloud_resources" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "resource_metric_stream_summaries_identity_key"
  ON "resource_metric_stream_summaries" (
    "cloud_connection_id", "provider_namespace", "region_id", "external_resource_id",
    "metric_name", "statistic", "granularity_seconds", "dimensions_hash"
  );
CREATE INDEX IF NOT EXISTS "resource_metric_stream_summaries_tenant_state_idx"
  ON "resource_metric_stream_summaries" ("tenant_id", "state", "last_sampled_at");
CREATE INDEX IF NOT EXISTS "resource_metric_stream_summaries_connection_metric_idx"
  ON "resource_metric_stream_summaries" ("cloud_connection_id", "metric_name", "statistic", "last_sampled_at");
CREATE INDEX IF NOT EXISTS "resource_metric_stream_summaries_resource_idx"
  ON "resource_metric_stream_summaries" ("cloud_resource_id", "last_sampled_at");
CREATE INDEX IF NOT EXISTS "resource_metric_stream_summaries_tenant_id_idx"
  ON "resource_metric_stream_summaries" ("tenant_id");
CREATE INDEX IF NOT EXISTS "resource_metric_stream_summaries_connection_id_idx"
  ON "resource_metric_stream_summaries" ("cloud_connection_id");

ALTER TABLE "cloud_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_metric_stream_summaries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "finops_resource_metric_stream_summary_isolation" ON "resource_metric_stream_summaries";
CREATE POLICY "finops_resource_metric_stream_summary_isolation"
  ON "resource_metric_stream_summaries"
  FOR ALL TO finops_runtime
  USING (
    (SELECT current_setting('app.user_role', true)) = 'MASTER_ADMIN'
    OR "tenant_id" = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) IS NOT NULL
  )
  WITH CHECK (
    (SELECT current_setting('app.user_role', true)) = 'MASTER_ADMIN'
    OR "tenant_id" = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) IS NOT NULL
  );

-- Persist the region and metric streams discovered from the provider.

CREATE TABLE IF NOT EXISTS "cloud_connection_regions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cloud_connection_id" TEXT NOT NULL,
  "region_id" TEXT NOT NULL,
  "subscribed" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
  "capabilities" JSONB,
  "last_error" TEXT,
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_validated_at" TIMESTAMPTZ(6),
  CONSTRAINT "cloud_connection_regions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cloud_connection_regions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cloud_connection_regions_connection_id_fkey"
    FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "cloud_connection_regions_connection_region_key"
  ON "cloud_connection_regions" ("cloud_connection_id", "region_id");
CREATE INDEX IF NOT EXISTS "cloud_connection_regions_tenant_status_idx"
  ON "cloud_connection_regions" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "cloud_connection_regions_connection_status_idx"
  ON "cloud_connection_regions" ("cloud_connection_id", "subscribed", "status");
CREATE INDEX IF NOT EXISTS "cloud_connection_regions_tenant_id_idx"
  ON "cloud_connection_regions" ("tenant_id");

CREATE TABLE IF NOT EXISTS "cloud_metric_definitions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "cloud_connection_id" TEXT NOT NULL,
  "cloud_connection_region_id" TEXT,
  "region_id" TEXT,
  "compartment_id" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "metric_name" TEXT NOT NULL,
  "external_resource_id" TEXT NOT NULL DEFAULT '',
  "dimensions" JSONB,
  "dimensions_hash" VARCHAR(64) NOT NULL DEFAULT '',
  "metric_unit" TEXT,
  "statistics" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "discovery_source" TEXT NOT NULL DEFAULT 'OCI_LIST_METRICS',
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_at" TIMESTAMPTZ(6),
  CONSTRAINT "cloud_metric_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cloud_metric_definitions_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cloud_metric_definitions_connection_id_fkey"
    FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cloud_metric_definitions_region_id_fkey"
    FOREIGN KEY ("cloud_connection_region_id") REFERENCES "cloud_connection_regions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "cloud_metric_definitions_identity_key"
  ON "cloud_metric_definitions" (
    "cloud_connection_id",
    "namespace",
    "metric_name",
    "compartment_id",
    "external_resource_id",
    "dimensions_hash"
  );
CREATE INDEX IF NOT EXISTS "cloud_metric_definitions_tenant_status_enabled_idx"
  ON "cloud_metric_definitions" ("tenant_id", "cloud_connection_id", "status", "enabled");
CREATE INDEX IF NOT EXISTS "cloud_metric_definitions_connection_region_metric_idx"
  ON "cloud_metric_definitions" ("cloud_connection_id", "region_id", "namespace", "metric_name");
CREATE INDEX IF NOT EXISTS "cloud_metric_definitions_connection_resource_metric_idx"
  ON "cloud_metric_definitions" ("cloud_connection_id", "external_resource_id", "metric_name");
CREATE INDEX IF NOT EXISTS "cloud_metric_definitions_tenant_id_idx"
  ON "cloud_metric_definitions" ("tenant_id");
CREATE INDEX IF NOT EXISTS "cloud_metric_definitions_region_id_idx"
  ON "cloud_metric_definitions" ("cloud_connection_region_id");

ALTER TABLE "cloud_connection_regions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "finops_cloud_connection_region_isolation" ON "cloud_connection_regions";
CREATE POLICY "finops_cloud_connection_region_isolation" ON "cloud_connection_regions"
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

ALTER TABLE "cloud_metric_definitions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "finops_cloud_metric_definition_isolation" ON "cloud_metric_definitions";
CREATE POLICY "finops_cloud_metric_definition_isolation" ON "cloud_metric_definitions"
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

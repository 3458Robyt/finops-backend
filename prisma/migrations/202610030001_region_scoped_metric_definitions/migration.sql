-- Metric identity is region-scoped for OCI and AWS. Normalize legacy unknown
-- regions to the empty sentinel before making the identity column non-null.
UPDATE "cloud_metric_definitions" AS definition
SET "region_id" = COALESCE(
  NULLIF(definition."region_id", ''),
  NULLIF((
    SELECT connection_region."region_id"
    FROM "cloud_connection_regions" AS connection_region
    WHERE connection_region."id" = definition."cloud_connection_region_id"
  ), ''),
  NULLIF((
    SELECT connection."default_region"
    FROM "cloud_connections" AS connection
    WHERE connection."id" = definition."cloud_connection_id"
  ), ''),
  ''
)
WHERE definition."region_id" IS NULL OR definition."region_id" = '';

ALTER TABLE "cloud_metric_definitions"
  ALTER COLUMN "region_id" SET DEFAULT '',
  ALTER COLUMN "region_id" SET NOT NULL;

DROP INDEX IF EXISTS "cloud_metric_definitions_identity_key";
CREATE UNIQUE INDEX "cloud_metric_definitions_identity_key"
  ON "cloud_metric_definitions" (
    "cloud_connection_id",
    "region_id",
    "namespace",
    "metric_name",
    "compartment_id",
    "external_resource_id",
    "dimensions_hash"
  );

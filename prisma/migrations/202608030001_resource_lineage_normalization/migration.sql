-- Normalize the inventory link for analytical costs and recommendations.
ALTER TABLE "cost_metrics"
  ADD COLUMN "cloud_resource_id" TEXT,
  ADD COLUMN "resource_link_reason" TEXT;

ALTER TABLE "recommendations"
  ADD COLUMN "cloud_resource_id" TEXT,
  ADD COLUMN "resource_link_reason" TEXT;

ALTER TABLE "resource_metric_samples"
  ADD COLUMN "resource_link_reason" TEXT;

CREATE INDEX "cost_metrics_tenant_id_cloud_resource_id_charge_period_start_idx"
  ON "cost_metrics"("tenant_id", "cloud_resource_id", "charge_period_start");

CREATE INDEX "recommendations_tenant_id_cloud_resource_id_created_at_idx"
  ON "recommendations"("tenant_id", "cloud_resource_id", "created_at");

ALTER TABLE "cost_metrics"
  ADD CONSTRAINT "cost_metrics_cloud_resource_id_fkey"
  FOREIGN KEY ("cloud_resource_id") REFERENCES "cloud_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "recommendations"
  ADD CONSTRAINT "recommendations_cloud_resource_id_fkey"
  FOREIGN KEY ("cloud_resource_id") REFERENCES "cloud_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A resource link is valid only inside the same tenant and ingestion connection.
-- The generic tenant guard covers tenant ownership; this trigger covers the
-- connection part of the canonical identity key.
CREATE OR REPLACE FUNCTION finops_assert_resource_connection_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  resource_tenant text;
  resource_connection text;
BEGIN
  IF NEW.cloud_resource_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.cloud_connection_id IS NULL THEN
    RAISE EXCEPTION 'A resource link requires a cloud connection'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT tenant_id::text, cloud_connection_id::text
    INTO resource_tenant, resource_connection
    FROM public.cloud_resources
   WHERE id = NEW.cloud_resource_id;

  IF resource_tenant IS NOT NULL AND (
    resource_tenant <> NEW.tenant_id::text OR resource_connection <> NEW.cloud_connection_id::text
  ) THEN
    RAISE EXCEPTION 'Resource relationship violates tenant or connection ownership'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION finops_assert_resource_connection_consistency() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_assert_resource_connection_consistency() TO finops_runtime;

DROP TRIGGER IF EXISTS finops_resource_connection_guard ON "cost_metrics";
CREATE TRIGGER finops_resource_connection_guard
  BEFORE INSERT OR UPDATE ON "cost_metrics"
  FOR EACH ROW EXECUTE FUNCTION finops_assert_resource_connection_consistency();

DROP TRIGGER IF EXISTS finops_resource_connection_guard ON "resource_metric_samples";
CREATE TRIGGER finops_resource_connection_guard
  BEFORE INSERT OR UPDATE ON "resource_metric_samples"
  FOR EACH ROW EXECUTE FUNCTION finops_assert_resource_connection_consistency();

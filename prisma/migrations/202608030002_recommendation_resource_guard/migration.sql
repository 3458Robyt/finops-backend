-- Keep recommendation resource references inside the owning tenant.
CREATE OR REPLACE FUNCTION finops_assert_recommendation_resource_tenant_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  resource_tenant text;
BEGIN
  IF NEW.cloud_resource_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tenant_id::text
    INTO resource_tenant
    FROM public.cloud_resources
   WHERE id = NEW.cloud_resource_id;

  IF resource_tenant IS NOT NULL AND resource_tenant <> NEW.tenant_id::text THEN
    RAISE EXCEPTION 'Recommendation resource relationship violates tenant ownership'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION finops_assert_recommendation_resource_tenant_consistency() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_assert_recommendation_resource_tenant_consistency() TO finops_runtime;

DROP TRIGGER IF EXISTS finops_recommendation_resource_guard ON "recommendations";
CREATE TRIGGER finops_recommendation_resource_guard
  BEFORE INSERT OR UPDATE ON "recommendations"
  FOR EACH ROW EXECUTE FUNCTION finops_assert_recommendation_resource_tenant_consistency();

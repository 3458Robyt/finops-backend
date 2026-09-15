-- Close the two remaining public tables reported by Supabase Advisors.
-- fx_rates is a backend-owned reference table; rollups remain tenant-owned.

ALTER TABLE "fx_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_metric_rollups" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "finops_fx_rates_backend_only" ON "fx_rates";
CREATE POLICY "finops_fx_rates_backend_only" ON "fx_rates"
  FOR ALL TO finops_runtime
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "finops_resource_metric_rollups_tenant_isolation" ON "resource_metric_rollups";
CREATE POLICY "finops_resource_metric_rollups_tenant_isolation" ON "resource_metric_rollups"
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());

REVOKE ALL PRIVILEGES ON TABLE "fx_rates" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE "resource_metric_rollups" FROM PUBLIC;

DO $$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['fx_rates', 'resource_metric_rollups'] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "fx_rates" TO finops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "resource_metric_rollups" TO finops_runtime;

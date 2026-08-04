-- Keep the API roles from reaching allocation data directly; the backend uses
-- the tenant-aware finops_runtime role after applying the request context.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I FROM %I', 'cost_allocation_rule_targets', role_name);
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I FROM %I', 'cost_allocation_closures', role_name);
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I FROM %I', 'cost_allocation_closure_lines', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "cost_allocation_rule_targets" TO finops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "cost_allocation_closures" TO finops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "cost_allocation_closure_lines" TO finops_runtime;

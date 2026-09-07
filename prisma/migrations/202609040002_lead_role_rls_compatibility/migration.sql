-- Application authorization keeps LEAD_TECHNICIAN distinct because it grants
-- AGENT_CONFIGURE. Existing RLS policies intentionally use the technician
-- access surface, so normalize only the database visibility role here.
CREATE OR REPLACE FUNCTION finops_current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE NULLIF(pg_catalog.current_setting('app.user_role', true), '')
    WHEN 'LEAD_TECHNICIAN' THEN 'FINOPS_TECHNICIAN'
    ELSE NULLIF(pg_catalog.current_setting('app.user_role', true), '')
  END
$$;

REVOKE ALL ON FUNCTION finops_current_user_role() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION finops_current_user_role() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION finops_current_user_role() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION finops_current_user_role() FROM service_role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'finops_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION finops_current_user_role() TO finops_runtime';
  END IF;
END
$$;

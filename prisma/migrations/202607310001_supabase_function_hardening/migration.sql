-- Keep RLS helper functions independent from caller-controlled search paths.
CREATE OR REPLACE FUNCTION finops_context_value(setting_name text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting(setting_name, true), '')
$$;

CREATE OR REPLACE FUNCTION finops_active_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')
$$;

CREATE OR REPLACE FUNCTION finops_current_user_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION finops_current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.user_role', true), '')
$$;

CREATE OR REPLACE FUNCTION finops_login_email()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.login_email', true), '')
$$;

ALTER FUNCTION finops_assert_tenant_consistency() SET search_path = pg_catalog;

REVOKE ALL ON FUNCTION finops_context_value(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_active_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_current_user_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_login_email() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_assert_tenant_consistency() FROM PUBLIC;

-- Supabase grants exposed-schema functions directly to API roles. Revoke those
-- grants when the roles exist, while keeping this migration portable PostgreSQL.
DO $$
DECLARE
  role_name text;
  function_signature text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      FOREACH function_signature IN ARRAY ARRAY[
        'finops_context_value(text)',
        'finops_active_tenant_id()',
        'finops_current_user_id()',
        'finops_current_user_role()',
        'finops_login_email()',
        'finops_assert_tenant_consistency()'
      ] LOOP
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %I.%s FROM %I',
          current_schema(),
          function_signature,
          role_name
        );
      END LOOP;
    END IF;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION finops_context_value(text) TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_active_tenant_id() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_current_user_id() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_current_user_role() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_login_email() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_assert_tenant_consistency() TO finops_runtime;

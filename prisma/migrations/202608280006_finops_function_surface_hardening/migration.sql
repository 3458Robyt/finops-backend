-- Close the remaining exposed-schema function surface.
-- FinOps helpers are called by the backend through finops_runtime and must not
-- be callable through Supabase API roles or resolve objects from a caller-
-- controlled search_path. Trigger helpers use explicit schema-qualified or
-- dynamically quoted table references, so pg_catalog is sufficient here.
DO $$
DECLARE
  helper record;
  role_name text;
  api_roles text[] := ARRAY['anon', 'authenticated', 'service_role'];
BEGIN
  FOR helper IN
    SELECT
      p.oid,
      n.nspname AS schema_name,
      p.proname AS function_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = pg_catalog.current_schema()
      AND p.proname LIKE 'finops_%'
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = pg_catalog',
      helper.schema_name,
      helper.function_name,
      helper.identity_arguments
    );

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC',
      helper.schema_name,
      helper.function_name,
      helper.identity_arguments
    );

    FOREACH role_name IN ARRAY api_roles LOOP
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name
      ) THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I',
          helper.schema_name,
          helper.function_name,
          helper.identity_arguments,
          role_name
        );
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'finops_runtime'
    ) THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION %I.%I(%s) TO finops_runtime',
        helper.schema_name,
        helper.function_name,
        helper.identity_arguments
      );
    END IF;
  END LOOP;
END
$$;

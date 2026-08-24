-- Schema-portable helper/trigger migrations can recreate functions after
-- Supabase default privileges have granted them directly to API roles. Remove
-- those grants explicitly; only the backend runtime may execute these helpers.
DO $migration$
DECLARE
  schema_name text := current_schema();
  function_signature text;
  role_name text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'finops_login_tenant_id()',
    'finops_guard_cost_allocation_closure_update()'
  ] LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %I.%s FROM PUBLIC',
      schema_name,
      function_signature
    );

    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name
      ) THEN
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %I.%s FROM %I',
          schema_name,
          function_signature,
          role_name
        );
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'finops_runtime'
    ) THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %I.%s TO finops_runtime',
        schema_name,
        function_signature
      );
    END IF;
  END LOOP;
END
$migration$;

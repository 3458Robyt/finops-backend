-- Keep the database context helpers safe when exposed through Supabase's
-- public schema. The application runs them only after switching to the
-- least-privileged finops_runtime role.
DO $$
DECLARE
  function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'finops_context_value(text)',
    'finops_active_tenant_id()',
    'finops_current_user_id()',
    'finops_current_user_role()',
    'finops_login_email()',
    'finops_assert_tenant_consistency()'
  ] LOOP
    IF to_regprocedure(format('%I.%s', current_schema(), function_signature)) IS NOT NULL THEN
      EXECUTE format(
        'ALTER FUNCTION %I.%s SET search_path = pg_catalog',
        current_schema(),
        function_signature
      );
    END IF;
  END LOOP;
END
$$;

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
        IF to_regprocedure(format('%I.%s', current_schema(), function_signature)) IS NOT NULL THEN
          EXECUTE format(
            'REVOKE ALL ON FUNCTION %I.%s FROM %I',
            current_schema(),
            function_signature,
            role_name
          );
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'finops_context_value(text)',
    'finops_active_tenant_id()',
    'finops_current_user_id()',
    'finops_current_user_role()',
    'finops_login_email()',
    'finops_assert_tenant_consistency()'
  ] LOOP
    IF to_regprocedure(format('%I.%s', current_schema(), function_signature)) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',
        current_schema(),
        function_signature
      );
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'finops_runtime') THEN
        EXECUTE format(
          'GRANT EXECUTE ON FUNCTION %I.%s TO finops_runtime',
          current_schema(),
          function_signature
        );
      END IF;
    END IF;
  END LOOP;
END
$$;

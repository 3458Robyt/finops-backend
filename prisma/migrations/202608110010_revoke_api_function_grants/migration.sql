-- Exposed-schema functions must not be callable through Supabase's API roles.
-- Keep trigger/RLS/auth helper execution available only to the runtime role.
DO $$
DECLARE
  function_signature text;
  role_name text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'finops_context_value(text)',
    'finops_active_tenant_id()',
    'finops_current_user_id()',
    'finops_current_user_role()',
    'finops_login_email()',
    'finops_assert_tenant_consistency()',
    'finops_assert_resource_connection_consistency()',
    'finops_assert_recommendation_resource_tenant_consistency()',
    'finops_guard_cost_allocation_closure_update()',
    'finops_refresh_token_hash()',
    'finops_refresh_family_id()',
    'finops_refresh_session_id()',
    'finops_refresh_user_id()',
    'finops_password_reset_token_hash()',
    'finops_password_reset_user_id()',
    'finops_mfa_challenge_token_hash()',
    'finops_mfa_challenge_user_id()',
    'finops_login_user_id()'
  ] LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.%s FROM PUBLIC',
      function_signature
    );

    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles
        WHERE rolname = role_name
      ) THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION public.%s FROM %I',
          function_signature,
          role_name
        );
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles
      WHERE rolname = 'finops_runtime'
    ) THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.%s TO finops_runtime',
        function_signature
      );
    END IF;
  END LOOP;
END
$$;


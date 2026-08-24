-- Keep SECURITY DEFINER helpers and relationship guards portable when the
-- backend runs against an isolated PostgreSQL schema (integration/E2E) or the
-- public Supabase schema. Previous versions hard-coded public.* in a few
-- helpers, which made pre-auth login invisible in isolated schemas.

DO $migration$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION %I.finops_login_user_id()
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    AS $body$
    DECLARE result text;
    BEGIN
      SELECT id INTO result FROM %I.users
        WHERE email = NULLIF(current_setting('app.login_email', true), '')
        LIMIT 1;
      RETURN result;
    END
    $body$;
  $function$, schema_name, schema_name, schema_name);

  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION %I.finops_refresh_user_id()
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    AS $body$
    DECLARE result text;
    BEGIN
      SELECT user_id INTO result FROM %I.auth_refresh_tokens
        WHERE token_hash = NULLIF(current_setting('app.refresh_token_hash', true), '')
        LIMIT 1;
      RETURN result;
    END
    $body$;
  $function$, schema_name, schema_name, schema_name);

  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION %I.finops_refresh_session_id()
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    AS $body$
    DECLARE result text;
    BEGIN
      SELECT session_id INTO result FROM %I.auth_refresh_tokens
        WHERE token_hash = NULLIF(current_setting('app.refresh_token_hash', true), '')
        LIMIT 1;
      RETURN result;
    END
    $body$;
  $function$, schema_name, schema_name, schema_name);

  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION %I.finops_password_reset_user_id()
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    AS $body$
    DECLARE result text;
    BEGIN
      SELECT user_id INTO result FROM %I.password_reset_tokens
        WHERE token_hash = NULLIF(current_setting('app.password_reset_token_hash', true), '')
        LIMIT 1;
      RETURN result;
    END
    $body$;
  $function$, schema_name, schema_name, schema_name);

  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION %I.finops_refresh_family_id()
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    AS $body$
    DECLARE result text;
    BEGIN
      SELECT family_id INTO result FROM %I.auth_refresh_tokens
        WHERE token_hash = NULLIF(current_setting('app.refresh_token_hash', true), '')
        LIMIT 1;
      RETURN result;
    END
    $body$;
  $function$, schema_name, schema_name, schema_name);

  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION %I.finops_mfa_challenge_user_id()
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    AS $body$
    DECLARE result text;
    BEGIN
      SELECT user_id INTO result FROM %I.mfa_challenges
        WHERE token_hash = NULLIF(current_setting('app.mfa_challenge_token_hash', true), '')
        LIMIT 1;
      RETURN result;
    END
    $body$;
  $function$, schema_name, schema_name, schema_name);

  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION %I.finops_login_tenant_id()
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %I
    AS $body$
    DECLARE result text;
    BEGIN
      SELECT tenant_id INTO result FROM %I.users
        WHERE email = NULLIF(current_setting('app.login_email', true), '')
        LIMIT 1;
      RETURN result;
    END
    $body$;
  $function$, schema_name, schema_name, schema_name);
END
$migration$;

DO $migration$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %I.finops_login_user_id() FROM PUBLIC', schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.finops_refresh_user_id() FROM PUBLIC', schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.finops_refresh_session_id() FROM PUBLIC', schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.finops_password_reset_user_id() FROM PUBLIC', schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.finops_refresh_family_id() FROM PUBLIC', schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.finops_mfa_challenge_user_id() FROM PUBLIC', schema_name);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.finops_login_tenant_id() FROM PUBLIC', schema_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.finops_login_user_id() TO finops_runtime', schema_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.finops_refresh_user_id() TO finops_runtime', schema_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.finops_refresh_session_id() TO finops_runtime', schema_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.finops_password_reset_user_id() TO finops_runtime', schema_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.finops_refresh_family_id() TO finops_runtime', schema_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.finops_mfa_challenge_user_id() TO finops_runtime', schema_name);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %I.finops_login_tenant_id() TO finops_runtime', schema_name);
END
$migration$;

DROP POLICY IF EXISTS finops_auth_refresh_isolation ON auth_refresh_tokens;
CREATE POLICY finops_auth_refresh_isolation ON auth_refresh_tokens
  FOR ALL TO finops_runtime
  USING (
    tenant_id = finops_active_tenant_id()
    OR user_id = finops_current_user_id()
    OR token_hash = finops_refresh_token_hash()
    OR family_id = finops_refresh_family_id()
    OR user_id = finops_password_reset_user_id()
    OR (user_id = finops_login_user_id() AND tenant_id = finops_login_tenant_id())
  )
  WITH CHECK (
    tenant_id = finops_active_tenant_id()
    OR user_id = finops_current_user_id()
    OR token_hash = finops_refresh_token_hash()
    OR family_id = finops_refresh_family_id()
    OR user_id = finops_password_reset_user_id()
    OR (user_id = finops_login_user_id() AND tenant_id = finops_login_tenant_id())
  );

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

  EXECUTE format(
    'SELECT tenant_id::text, cloud_connection_id::text FROM %I.cloud_resources WHERE id = $1',
    TG_TABLE_SCHEMA
  )
  INTO resource_tenant, resource_connection
  USING NEW.cloud_resource_id;

  IF resource_tenant IS NOT NULL AND (
    resource_tenant <> NEW.tenant_id::text OR resource_connection <> NEW.cloud_connection_id::text
  ) THEN
    RAISE EXCEPTION 'Resource relationship violates tenant or connection ownership'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

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

  EXECUTE format(
    'SELECT tenant_id::text FROM %I.cloud_resources WHERE id = $1',
    TG_TABLE_SCHEMA
  )
  INTO resource_tenant
  USING NEW.cloud_resource_id;

  IF resource_tenant IS NOT NULL AND resource_tenant <> NEW.tenant_id::text THEN
    RAISE EXCEPTION 'Recommendation resource relationship violates tenant ownership'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION finops_assert_resource_connection_consistency() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_assert_recommendation_resource_tenant_consistency() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_assert_resource_connection_consistency() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_assert_recommendation_resource_tenant_consistency() TO finops_runtime;

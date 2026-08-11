-- Resolve pre-auth identities through SECURITY DEFINER helpers so policies do
-- not recursively query other RLS-protected credential tables.

CREATE OR REPLACE FUNCTION finops_login_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id
  FROM public.users u
  WHERE u.email = NULLIF(current_setting('app.login_email', true), '')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION finops_refresh_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.user_id
  FROM public.auth_refresh_tokens r
  WHERE r.token_hash = NULLIF(current_setting('app.refresh_token_hash', true), '')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION finops_refresh_session_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.session_id
  FROM public.auth_refresh_tokens r
  WHERE r.token_hash = NULLIF(current_setting('app.refresh_token_hash', true), '')
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION finops_login_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_refresh_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_refresh_session_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_login_user_id() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_refresh_user_id() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_refresh_session_id() TO finops_runtime;

ALTER POLICY finops_user_directory ON users
  USING (
    finops_current_user_role() = 'MASTER_ADMIN'
    OR id = finops_current_user_id()
    OR tenant_id = finops_active_tenant_id()
    OR id = finops_login_user_id()
    OR id = finops_refresh_user_id()
    OR id = finops_password_reset_user_id()
  );

ALTER POLICY finops_user_update ON users
  USING (
    finops_current_user_role() = 'MASTER_ADMIN'
    OR id = finops_current_user_id()
    OR id = finops_login_user_id()
    OR id = finops_refresh_user_id()
    OR id = finops_password_reset_user_id()
  )
  WITH CHECK (
    finops_current_user_role() = 'MASTER_ADMIN'
    OR id = finops_current_user_id()
    OR id = finops_login_user_id()
    OR id = finops_refresh_user_id()
    OR id = finops_password_reset_user_id()
  );

ALTER POLICY finops_session_isolation ON auth_sessions
  USING (
    user_id = finops_current_user_id()
    OR finops_current_user_role() = 'MASTER_ADMIN'
    OR user_id = finops_login_user_id()
    OR id = finops_refresh_session_id()
    OR user_id = finops_password_reset_user_id()
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR finops_current_user_role() = 'MASTER_ADMIN'
    OR user_id = finops_login_user_id()
    OR id = finops_refresh_session_id()
    OR user_id = finops_password_reset_user_id()
  );

ALTER POLICY finops_password_reset_isolation ON password_reset_tokens
  USING (
    user_id = finops_current_user_id()
    OR token_hash = finops_password_reset_token_hash()
    OR user_id = finops_login_user_id()
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR token_hash = finops_password_reset_token_hash()
    OR user_id = finops_login_user_id()
  );

ALTER POLICY finops_user_mfa_isolation ON user_mfa
  USING (
    user_id = finops_current_user_id()
    OR user_id = finops_mfa_challenge_user_id()
    OR user_id = finops_login_user_id()
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR user_id = finops_mfa_challenge_user_id()
    OR user_id = finops_login_user_id()
  );

ALTER POLICY finops_mfa_challenge_isolation ON mfa_challenges
  USING (
    user_id = finops_current_user_id()
    OR token_hash = finops_mfa_challenge_token_hash()
    OR user_id = finops_login_user_id()
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR token_hash = finops_mfa_challenge_token_hash()
    OR user_id = finops_login_user_id()
  );

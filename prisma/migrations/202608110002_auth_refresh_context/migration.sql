-- Allow the backend to rotate a refresh session before it has an access JWT.
-- The hash is set only on the server-side connection context; the raw cookie
-- never reaches PostgreSQL.
CREATE OR REPLACE FUNCTION finops_refresh_token_hash()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.refresh_token_hash', true), '')
$$;

REVOKE ALL ON FUNCTION finops_refresh_token_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_refresh_token_hash() TO finops_runtime;

ALTER POLICY finops_session_isolation ON auth_sessions
  USING (
    user_id = finops_current_user_id()
    OR finops_current_user_role() = 'MASTER_ADMIN'
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.email = finops_login_email())
    OR EXISTS (
      SELECT 1 FROM auth_refresh_tokens r
      WHERE r.session_id = auth_sessions.id
        AND r.token_hash = finops_refresh_token_hash()
    )
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR finops_current_user_role() = 'MASTER_ADMIN'
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.email = finops_login_email())
    OR EXISTS (
      SELECT 1 FROM auth_refresh_tokens r
      WHERE r.session_id = auth_sessions.id
        AND r.token_hash = finops_refresh_token_hash()
    )
  );

ALTER POLICY finops_user_directory ON users
  USING (
    finops_current_user_role() = 'MASTER_ADMIN'
    OR id = finops_current_user_id()
    OR tenant_id = finops_active_tenant_id()
    OR email = finops_login_email()
    OR EXISTS (
      SELECT 1 FROM auth_refresh_tokens r
      WHERE r.user_id = users.id
        AND r.token_hash = finops_refresh_token_hash()
    )
  );

ALTER POLICY finops_user_update ON users
  USING (
    finops_current_user_role() = 'MASTER_ADMIN'
    OR id = finops_current_user_id()
    OR email = finops_login_email()
    OR EXISTS (
      SELECT 1 FROM auth_refresh_tokens r
      WHERE r.user_id = users.id
        AND r.token_hash = finops_refresh_token_hash()
    )
  )
  WITH CHECK (
    finops_current_user_role() = 'MASTER_ADMIN'
    OR id = finops_current_user_id()
    OR email = finops_login_email()
    OR EXISTS (
      SELECT 1 FROM auth_refresh_tokens r
      WHERE r.user_id = users.id
        AND r.token_hash = finops_refresh_token_hash()
    )
  );

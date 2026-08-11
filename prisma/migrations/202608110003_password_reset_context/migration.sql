CREATE OR REPLACE FUNCTION finops_password_reset_token_hash()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.password_reset_token_hash', true), '')
$$;

REVOKE ALL ON FUNCTION finops_password_reset_token_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_password_reset_token_hash() TO finops_runtime;

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
    OR EXISTS (
      SELECT 1 FROM password_reset_tokens p
      WHERE p.user_id = users.id
        AND p.token_hash = finops_password_reset_token_hash()
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
    OR EXISTS (
      SELECT 1 FROM password_reset_tokens p
      WHERE p.user_id = users.id
        AND p.token_hash = finops_password_reset_token_hash()
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
    OR EXISTS (
      SELECT 1 FROM password_reset_tokens p
      WHERE p.user_id = users.id
        AND p.token_hash = finops_password_reset_token_hash()
    )
  );

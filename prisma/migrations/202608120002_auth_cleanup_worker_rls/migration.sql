-- Allow only the dedicated maintenance worker to purge authentication
-- artifacts that are intentionally outside a tenant request context.
CREATE OR REPLACE FUNCTION finops_auth_cleanup_worker()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT current_setting('app.user_role', true) = 'MASTER_ADMIN'
    AND current_setting('app.worker_id', true) = 'finops-maintenance:auth-lifecycle'
$$;

REVOKE ALL ON FUNCTION finops_auth_cleanup_worker() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_auth_cleanup_worker() TO finops_runtime;

ALTER POLICY finops_auth_refresh_isolation ON auth_refresh_tokens
  USING (
    tenant_id = finops_active_tenant_id()
    OR user_id = finops_current_user_id()
    OR token_hash = finops_refresh_token_hash()
    OR family_id = finops_refresh_family_id()
    OR user_id = finops_password_reset_user_id()
    OR (finops_auth_cleanup_worker() AND expires_at <= CURRENT_TIMESTAMP)
  )
  WITH CHECK (
    tenant_id = finops_active_tenant_id()
    OR user_id = finops_current_user_id()
    OR token_hash = finops_refresh_token_hash()
    OR family_id = finops_refresh_family_id()
    OR user_id = finops_password_reset_user_id()
  );

ALTER POLICY finops_password_reset_isolation ON password_reset_tokens
  USING (
    user_id = finops_current_user_id()
    OR token_hash = finops_password_reset_token_hash()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = password_reset_tokens.user_id
        AND u.email = finops_login_email()
    )
    OR (finops_auth_cleanup_worker() AND expires_at <= CURRENT_TIMESTAMP)
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR token_hash = finops_password_reset_token_hash()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = password_reset_tokens.user_id
        AND u.email = finops_login_email()
    )
  );

ALTER POLICY finops_mfa_challenge_isolation ON mfa_challenges
  USING (
    user_id = finops_current_user_id()
    OR token_hash = finops_mfa_challenge_token_hash()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = mfa_challenges.user_id
        AND u.email = finops_login_email()
    )
    OR (finops_auth_cleanup_worker() AND expires_at <= CURRENT_TIMESTAMP)
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR token_hash = finops_mfa_challenge_token_hash()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = mfa_challenges.user_id
        AND u.email = finops_login_email()
    )
  );

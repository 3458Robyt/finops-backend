-- The portable-auth migration rebuilds the normal refresh-token policy for
-- isolated schemas. Preserve the dedicated maintenance-worker delete path
-- while keeping it limited to already-expired rows.
ALTER POLICY finops_auth_refresh_isolation ON auth_refresh_tokens
  USING (
    tenant_id = finops_active_tenant_id()
    OR user_id = finops_current_user_id()
    OR token_hash = finops_refresh_token_hash()
    OR family_id = finops_refresh_family_id()
    OR user_id = finops_password_reset_user_id()
    OR (user_id = finops_login_user_id() AND tenant_id = finops_login_tenant_id())
    OR (finops_auth_cleanup_worker() AND expires_at <= CURRENT_TIMESTAMP)
  );

-- Keep the bounded cleanup index-backed and limit the maintenance context to
-- deleting rows that are already expired. The worker never receives a write
-- path through WITH CHECK.
CREATE INDEX IF NOT EXISTS "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");
CREATE INDEX IF NOT EXISTS "auth_refresh_tokens_expires_at_idx" ON "auth_refresh_tokens"("expires_at");
CREATE INDEX IF NOT EXISTS "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");
CREATE INDEX IF NOT EXISTS "mfa_challenges_expires_at_idx" ON "mfa_challenges"("expires_at");

-- The bounded worker needs to inspect refresh-token existence when deciding
-- whether an expired session can be deleted safely. This SELECT-only policy
-- lets the relation filter see future refresh rows, while the FOR ALL policy
-- from the previous migration still limits DELETE to expired rows and keeps
-- INSERT/UPDATE behind the normal auth predicates. The application never
-- exposes this maintenance context through an API or generic RPC.
CREATE POLICY finops_auth_refresh_cleanup_visibility ON auth_refresh_tokens
  FOR SELECT TO finops_runtime
  USING (finops_auth_cleanup_worker());

ALTER POLICY finops_session_isolation ON auth_sessions
  USING (
    user_id = finops_current_user_id()
    OR user_id = finops_login_user_id()
    OR id = finops_refresh_session_id()
    OR user_id = finops_password_reset_user_id()
    OR (
      finops_auth_cleanup_worker()
      AND expires_at <= CURRENT_TIMESTAMP
    )
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR user_id = finops_login_user_id()
    OR id = finops_refresh_session_id()
    OR user_id = finops_password_reset_user_id()
  );

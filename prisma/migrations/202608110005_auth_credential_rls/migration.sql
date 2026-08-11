-- Keep authentication credentials tenant-aware even when the API uses the
-- non-owner runtime role. Pre-auth flows use one-time hashes in the server
-- connection context; raw secrets never reach PostgreSQL.

CREATE OR REPLACE FUNCTION finops_mfa_challenge_token_hash()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.mfa_challenge_token_hash', true), '')
$$;

CREATE OR REPLACE FUNCTION finops_password_reset_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.user_id
  FROM public.password_reset_tokens p
  WHERE p.token_hash = NULLIF(current_setting('app.password_reset_token_hash', true), '')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION finops_refresh_family_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.family_id
  FROM public.auth_refresh_tokens r
  WHERE r.token_hash = NULLIF(current_setting('app.refresh_token_hash', true), '')
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION finops_mfa_challenge_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.user_id
  FROM public.mfa_challenges c
  WHERE c.token_hash = NULLIF(current_setting('app.mfa_challenge_token_hash', true), '')
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION finops_mfa_challenge_token_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_password_reset_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_refresh_family_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_mfa_challenge_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_mfa_challenge_token_hash() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_password_reset_user_id() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_refresh_family_id() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_mfa_challenge_user_id() TO finops_runtime;

ALTER TABLE "auth_refresh_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_auth_refresh_isolation ON "auth_refresh_tokens"
  FOR ALL TO finops_runtime
  USING (
    tenant_id = finops_active_tenant_id()
    OR user_id = finops_current_user_id()
    OR token_hash = finops_refresh_token_hash()
    OR family_id = finops_refresh_family_id()
    OR user_id = finops_password_reset_user_id()
  )
  WITH CHECK (
    tenant_id = finops_active_tenant_id()
    OR user_id = finops_current_user_id()
    OR token_hash = finops_refresh_token_hash()
    OR family_id = finops_refresh_family_id()
    OR user_id = finops_password_reset_user_id()
  );

ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_password_reset_isolation ON "password_reset_tokens"
  FOR ALL TO finops_runtime
  USING (
    user_id = finops_current_user_id()
    OR token_hash = finops_password_reset_token_hash()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = password_reset_tokens.user_id
        AND u.email = finops_login_email()
    )
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

ALTER TABLE "user_mfa" ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_user_mfa_isolation ON "user_mfa"
  FOR ALL TO finops_runtime
  USING (
    user_id = finops_current_user_id()
    OR user_id = finops_mfa_challenge_user_id()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = user_mfa.user_id
        AND u.email = finops_login_email()
    )
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR user_id = finops_mfa_challenge_user_id()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = user_mfa.user_id
        AND u.email = finops_login_email()
    )
  );

ALTER TABLE "mfa_challenges" ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_mfa_challenge_isolation ON "mfa_challenges"
  FOR ALL TO finops_runtime
  USING (
    user_id = finops_current_user_id()
    OR token_hash = finops_mfa_challenge_token_hash()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = mfa_challenges.user_id
        AND u.email = finops_login_email()
    )
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

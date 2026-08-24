-- finops_auth_refresh_isolation already contains the expired-row branch for
-- the cleanup worker. The additional permissive SELECT policy was redundant
-- and made every refresh-token read evaluate two policies.
DROP POLICY IF EXISTS "finops_auth_refresh_cleanup_visibility" ON "auth_refresh_tokens";

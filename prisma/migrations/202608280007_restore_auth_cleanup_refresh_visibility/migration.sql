-- The auth cleanup worker must see non-expired refresh tokens when deciding
-- whether an expired session can be deleted. The FOR ALL policy intentionally
-- hides those rows from the worker because it only permits deletion of
-- expired tokens; without this SELECT policy, the NOT EXISTS check in the
-- cleanup repository cannot protect sessions that still have a live token.
CREATE POLICY finops_auth_refresh_cleanup_visibility ON auth_refresh_tokens
  FOR SELECT TO finops_runtime
  USING (finops_auth_cleanup_worker());

-- Supabase can grant newly-created functions explicitly to API roles through
-- default privileges. Remove those grants explicitly; the maintenance guard
-- is callable only by the backend runtime role.
REVOKE ALL ON FUNCTION finops_auth_cleanup_worker() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION finops_auth_cleanup_worker() TO finops_runtime;

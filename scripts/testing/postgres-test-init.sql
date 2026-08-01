-- Supabase exposes these roles, while the local integration image does not.
-- Create harmless NOLOGIN stand-ins so the same RLS migrations run in both environments.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END
$$;

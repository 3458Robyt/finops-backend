-- The application accesses these tables through the authenticated backend.
-- Prevent Supabase PostgREST roles from bypassing backend tenant authorization.
REVOKE ALL PRIVILEGES ON TABLE
  "cloud_connections",
  "cloud_connection_credentials",
  "ingestion_jobs",
  "ingestion_objects",
  "ingestion_watermarks",
  "data_quality_checks"
FROM anon, authenticated;

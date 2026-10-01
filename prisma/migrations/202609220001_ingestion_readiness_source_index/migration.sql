-- Supports readiness aggregation of successful source types without scanning
-- every job for a tenant after technical backfills grow the history.
CREATE INDEX IF NOT EXISTS "ingestion_jobs_tenant_status_source_idx"
ON "ingestion_jobs" ("tenant_id", "status", "cloud_connection_id", "source_type");

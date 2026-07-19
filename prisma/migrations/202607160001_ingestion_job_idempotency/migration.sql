-- Prevent concurrent activation/backfill requests from creating the same active window twice.
-- Failed and cancelled windows remain retryable.
CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_jobs_active_window_key"
ON "ingestion_jobs" (
  "tenant_id",
  "cloud_connection_id",
  "source_type",
  "target_start",
  "target_end"
)
WHERE "status" IN ('PENDING', 'RUNNING');

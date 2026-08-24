-- Concurrent, observable ingestion queue. Jobs are never physically deleted by
-- the application: cancellation and archiving preserve operational history.
ALTER TYPE "IngestionJobStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

ALTER TABLE "ingestion_jobs"
  ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "progress" JSONB,
  ADD COLUMN IF NOT EXISTS "cancel_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "cancel_requested_by_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "archived_by_user_id" TEXT;

CREATE INDEX IF NOT EXISTS "ingestion_jobs_queue_idx"
  ON "ingestion_jobs" ("status", "available_at", "priority", "created_at");
CREATE INDEX IF NOT EXISTS "ingestion_jobs_tenant_archive_idx"
  ON "ingestion_jobs" ("tenant_id", "archived_at", "created_at");

CREATE INDEX IF NOT EXISTS "ingestion_jobs_cancel_requested_by_user_id_idx"
  ON "ingestion_jobs" ("cancel_requested_by_user_id");
CREATE INDEX IF NOT EXISTS "ingestion_jobs_archived_by_user_id_idx"
  ON "ingestion_jobs" ("archived_by_user_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ingestion_jobs_cancel_requested_by_user_id_fkey'
  ) THEN
    ALTER TABLE "ingestion_jobs"
      ADD CONSTRAINT "ingestion_jobs_cancel_requested_by_user_id_fkey"
      FOREIGN KEY ("cancel_requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ingestion_jobs_archived_by_user_id_fkey'
  ) THEN
    ALTER TABLE "ingestion_jobs"
      ADD CONSTRAINT "ingestion_jobs_archived_by_user_id_fkey"
      FOREIGN KEY ("archived_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

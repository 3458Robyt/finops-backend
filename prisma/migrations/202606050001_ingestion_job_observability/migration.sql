ALTER TABLE "ingestion_jobs"
  ADD COLUMN "started_at" TIMESTAMPTZ(6),
  ADD COLUMN "completed_at" TIMESTAMPTZ(6),
  ADD COLUMN "result_summary" JSONB;

CREATE INDEX "ingestion_jobs_status_locked_at_idx"
  ON "ingestion_jobs"("status", "locked_at");

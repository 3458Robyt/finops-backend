ALTER TABLE "recommendation_analysis_runs"
  ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(6);

CREATE INDEX "recommendation_analysis_runs_status_cancel_requested_at_idx"
  ON "recommendation_analysis_runs" ("status", "cancel_requested_at");

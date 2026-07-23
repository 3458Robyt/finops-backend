ALTER TYPE "InAppNotificationType"
ADD VALUE IF NOT EXISTS 'RECOMMENDATION_ANALYSIS_COMPLETED';

CREATE TYPE "RecommendationAnalysisRunStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'PARTIAL',
  'SKIPPED',
  'FAILED',
  'CANCELLED'
);

CREATE TYPE "RecommendationAnalysisRunStage" AS ENUM (
  'QUEUED',
  'SELECTING_DATA',
  'DETERMINISTIC_ANALYSIS',
  'EVIDENCE_GATE',
  'AI_GENERATION',
  'AI_AUDIT',
  'PERSISTENCE',
  'NOTIFICATION',
  'FINISHED'
);

CREATE TYPE "RecommendationAnalysisTrigger" AS ENUM (
  'MANUAL',
  'SCHEDULED',
  'POST_INGESTION',
  'RETRY'
);

CREATE TYPE "RecommendationAnalysisScope" AS ENUM (
  'TENANT',
  'RESOURCE'
);

CREATE TYPE "RecommendationAnalysisRecommendationDisposition" AS ENUM (
  'CREATED',
  'REUSED'
);

CREATE TABLE "recommendation_analysis_runs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "requested_by_user_id" TEXT,
  "retried_from_run_id" TEXT,
  "trigger" "RecommendationAnalysisTrigger" NOT NULL DEFAULT 'MANUAL',
  "scope" "RecommendationAnalysisScope" NOT NULL DEFAULT 'TENANT',
  "scope_key" TEXT NOT NULL,
  "external_resource_id" TEXT,
  "status" "RecommendationAnalysisRunStatus" NOT NULL DEFAULT 'PENDING',
  "stage" "RecommendationAnalysisRunStage" NOT NULL DEFAULT 'QUEUED',
  "period_start" TIMESTAMPTZ(6),
  "period_end" TIMESTAMPTZ(6),
  "evidence_hash" TEXT,
  "snapshot" JSONB,
  "evidence_snapshot" JSONB,
  "readiness_report" JSONB,
  "candidate_results" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 2,
  "resources_evaluated" INTEGER NOT NULL DEFAULT 0,
  "candidates_found" INTEGER NOT NULL DEFAULT 0,
  "candidates_skipped" INTEGER NOT NULL DEFAULT 0,
  "recommendations_generated" INTEGER NOT NULL DEFAULT 0,
  "recommendations_rejected" INTEGER NOT NULL DEFAULT 0,
  "recommendations_persisted" INTEGER NOT NULL DEFAULT 0,
  "model" TEXT,
  "auditor_model" TEXT,
  "prompt_token_estimate" INTEGER NOT NULL DEFAULT 0,
  "response_token_estimate" INTEGER NOT NULL DEFAULT 0,
  "latency_ms" INTEGER,
  "worker_id" TEXT,
  "locked_at" TIMESTAMPTZ(6),
  "next_attempt_at" TIMESTAMPTZ(6),
  "error_code" TEXT,
  "error_message" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "recommendation_analysis_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recommendation_analysis_runs_scope_check"
    CHECK (
      ("scope" = 'TENANT' AND "external_resource_id" IS NULL)
      OR
      ("scope" = 'RESOURCE' AND "external_resource_id" IS NOT NULL)
    ),
  CONSTRAINT "recommendation_analysis_runs_period_check"
    CHECK ("period_start" IS NULL OR "period_end" IS NULL OR "period_end" > "period_start"),
  CONSTRAINT "recommendation_analysis_runs_attempts_check"
    CHECK ("attempts" >= 0 AND "max_attempts" > 0),
  CONSTRAINT "recommendation_analysis_runs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_analysis_runs_requested_by_user_id_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "recommendation_analysis_runs_retried_from_run_id_fkey"
    FOREIGN KEY ("retried_from_run_id") REFERENCES "recommendation_analysis_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "recommendation_analysis_run_recommendations" (
  "run_id" TEXT NOT NULL,
  "recommendation_id" TEXT NOT NULL,
  "candidate_id" TEXT,
  "disposition" "RecommendationAnalysisRecommendationDisposition" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recommendation_analysis_run_recommendations_pkey"
    PRIMARY KEY ("run_id", "recommendation_id"),
  CONSTRAINT "recommendation_analysis_run_recommendations_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "recommendation_analysis_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_analysis_run_recommendations_recommendation_id_fkey"
    FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "recommendation_analysis_runs_tenant_id_created_at_idx"
  ON "recommendation_analysis_runs"("tenant_id", "created_at");
CREATE INDEX "recommendation_analysis_runs_tenant_id_status_next_attempt_at_idx"
  ON "recommendation_analysis_runs"("tenant_id", "status", "next_attempt_at");
CREATE INDEX "recommendation_analysis_runs_tenant_id_scope_key_evidence_hash_idx"
  ON "recommendation_analysis_runs"("tenant_id", "scope_key", "evidence_hash");
CREATE INDEX "recommendation_analysis_runs_status_next_attempt_at_created_at_idx"
  ON "recommendation_analysis_runs"("status", "next_attempt_at", "created_at");
CREATE INDEX "recommendation_analysis_runs_requested_by_user_id_created_at_idx"
  ON "recommendation_analysis_runs"("requested_by_user_id", "created_at");
CREATE INDEX "recommendation_analysis_run_recommendations_recommendation_id_created_at_idx"
  ON "recommendation_analysis_run_recommendations"("recommendation_id", "created_at");

CREATE UNIQUE INDEX "recommendation_analysis_runs_one_active_scope_idx"
  ON "recommendation_analysis_runs"("tenant_id", "scope_key")
  WHERE "status" IN ('PENDING', 'RUNNING');

REVOKE ALL ON TABLE "recommendation_analysis_runs" FROM anon, authenticated;
REVOKE ALL ON TABLE "recommendation_analysis_run_recommendations" FROM anon, authenticated;

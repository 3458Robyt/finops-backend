CREATE TYPE "RecommendationAnalysisCandidateFinalDisposition" AS ENUM (
  'PUBLISHED',
  'REJECTED',
  'SKIPPED'
);

CREATE TABLE "recommendation_analysis_candidate_audits" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "candidate_id" TEXT NOT NULL,
  "draft_index" INTEGER NOT NULL,
  "recommendation_id" TEXT,
  "deterministic_evidence" JSONB,
  "draft" JSONB,
  "audit_verdict" "AiAuditVerdict" NOT NULL,
  "audit_score" INTEGER NOT NULL,
  "audit_checks" JSONB NOT NULL,
  "blocking_issues" JSONB NOT NULL,
  "required_changes" JSONB NOT NULL,
  "repair_attempt" INTEGER NOT NULL DEFAULT 0,
  "final_disposition" "RecommendationAnalysisCandidateFinalDisposition" NOT NULL,
  "model" TEXT,
  "auditor_model" TEXT,
  "prompt_hash" TEXT,
  "evidence_hash" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recommendation_analysis_candidate_audits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recommendation_analysis_candidate_audits_run_id_draft_index_key"
  ON "recommendation_analysis_candidate_audits"("run_id", "draft_index");
CREATE INDEX "recommendation_analysis_candidate_audits_tenant_id_created_at_idx"
  ON "recommendation_analysis_candidate_audits"("tenant_id", "created_at");
CREATE INDEX "recommendation_analysis_candidate_audits_tenant_id_candidate_id_created_at_idx"
  ON "recommendation_analysis_candidate_audits"("tenant_id", "candidate_id", "created_at");
CREATE INDEX "recommendation_analysis_candidate_audits_recommendation_id_created_at_idx"
  ON "recommendation_analysis_candidate_audits"("recommendation_id", "created_at");

ALTER TABLE "recommendation_analysis_candidate_audits"
  ADD CONSTRAINT "recommendation_analysis_candidate_audits_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_analysis_candidate_audits"
  ADD CONSTRAINT "recommendation_analysis_candidate_audits_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "recommendation_analysis_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recommendation_analysis_candidate_audits"
  ADD CONSTRAINT "recommendation_analysis_candidate_audits_recommendation_id_fkey"
  FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "recommendation_analysis_candidate_audits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "finops_recommendation_analysis_candidate_audit_isolation"
  ON "recommendation_analysis_candidate_audits"
  FOR ALL TO finops_runtime
  USING ("tenant_id" = finops_active_tenant_id())
  WITH CHECK ("tenant_id" = finops_active_tenant_id());

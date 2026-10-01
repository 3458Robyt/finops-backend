-- Preserve the exact cost facts that supported each generated recommendation.
-- This is an immutable evidence snapshot, not a live FK to replaceable cost_metrics.
CREATE TABLE "recommendation_cost_evidence" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "recommendation_id" TEXT NOT NULL,
  "cloud_account_id" TEXT NOT NULL,
  "cloud_connection_id" TEXT,
  "cloud_resource_id" TEXT NOT NULL,
  "provider" "CloudProvider" NOT NULL,
  "resource_id" TEXT NOT NULL,
  "service_name" TEXT NOT NULL,
  "charge_period_start" TIMESTAMPTZ(6) NOT NULL,
  "metric_identity_hash" TEXT NOT NULL,
  "billing_currency" VARCHAR(3) NOT NULL,
  "billed_cost" DECIMAL(18,6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recommendation_cost_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recommendation_cost_evidence_identity_key"
    UNIQUE ("recommendation_id", "charge_period_start", "metric_identity_hash"),
  CONSTRAINT "recommendation_cost_evidence_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "recommendation_cost_evidence_recommendation_id_fkey"
    FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "recommendation_cost_evidence_tenant_recommendation_idx"
  ON "recommendation_cost_evidence"("tenant_id", "recommendation_id");
CREATE INDEX "recommendation_cost_evidence_tenant_period_identity_idx"
  ON "recommendation_cost_evidence"("tenant_id", "charge_period_start", "metric_identity_hash");

ALTER TABLE "recommendation_cost_evidence" ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_tenant_isolation ON "recommendation_cost_evidence"
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());

REVOKE ALL ON TABLE "recommendation_cost_evidence" FROM PUBLIC;
REVOKE UPDATE, DELETE ON TABLE "recommendation_cost_evidence" FROM finops_runtime;
GRANT SELECT, INSERT ON TABLE "recommendation_cost_evidence" TO finops_runtime;

CREATE TRIGGER finops_tenant_relationship_guard
  BEFORE INSERT OR UPDATE ON "recommendation_cost_evidence"
  FOR EACH ROW EXECUTE FUNCTION finops_assert_tenant_consistency();

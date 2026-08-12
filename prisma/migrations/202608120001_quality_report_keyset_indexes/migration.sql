-- Supporting indexes for tenant-scoped keyset pagination in the AI quality report.
CREATE INDEX "recommendations_tenant_id_created_at_id_idx"
  ON "recommendations"("tenant_id", "created_at", "id");

CREATE INDEX "ai_context_traces_tenant_id_created_at_id_idx"
  ON "ai_context_traces"("tenant_id", "created_at", "id");

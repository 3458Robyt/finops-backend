-- Cover the remaining public foreign keys reported by Supabase's performance advisor.
-- These indexes support tenant-safe joins and parent-row updates/deletes; they do
-- not replace the existing workload-specific indexes.
CREATE INDEX IF NOT EXISTS "auth_refresh_tokens_tenant_id_idx"
  ON "auth_refresh_tokens"("tenant_id");

CREATE INDEX IF NOT EXISTS "cost_allocation_closure_lines_closure_id_tenant_id_idx"
  ON "cost_allocation_closure_lines"("closure_id", "tenant_id");

CREATE INDEX IF NOT EXISTS "cost_allocation_closures_closed_by_user_id_idx"
  ON "cost_allocation_closures"("closed_by_user_id");

CREATE INDEX IF NOT EXISTS "cost_allocation_rule_targets_rule_id_tenant_id_idx"
  ON "cost_allocation_rule_targets"("rule_id", "tenant_id");

CREATE INDEX IF NOT EXISTS "cost_metrics_cloud_resource_id_idx"
  ON "cost_metrics"("cloud_resource_id");

CREATE INDEX IF NOT EXISTS "recommendations_cloud_resource_id_idx"
  ON "recommendations"("cloud_resource_id");


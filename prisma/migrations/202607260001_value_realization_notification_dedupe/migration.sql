ALTER TABLE "in_app_notifications"
  ADD COLUMN "dedupe_key" VARCHAR(160);

CREATE UNIQUE INDEX "in_app_notifications_tenant_id_user_id_dedupe_key_key"
  ON "in_app_notifications"("tenant_id", "user_id", "dedupe_key");

CREATE INDEX "recommendation_manual_executions_tenant_id_status_executed_at_idx"
  ON "recommendation_manual_executions"("tenant_id", "status", "executed_at");

CREATE INDEX "recommendation_savings_measurements_tenant_id_manual_execution_id_status_created_at_idx"
  ON "recommendation_savings_measurements"("tenant_id", "manual_execution_id", "status", "created_at");

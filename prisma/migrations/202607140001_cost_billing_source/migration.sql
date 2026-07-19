-- Tracks the source used to project a cost metric and enables reconciliation
-- between FOCUS exports and provider billing APIs per cloud connection.
CREATE TYPE "CostBillingSource" AS ENUM ('FOCUS', 'PROVIDER_API', 'LEGACY', 'UNKNOWN');

ALTER TABLE "cost_metrics"
  ADD COLUMN "cloud_connection_id" TEXT,
  ADD COLUMN "billing_source" "CostBillingSource" NOT NULL DEFAULT 'UNKNOWN';

UPDATE "cost_metrics"
SET "cloud_connection_id" = "ingestion_runs"."cloud_connection_id"
FROM "ingestion_runs"
WHERE "cost_metrics"."ingestion_run_id" = "ingestion_runs"."id"
  AND "cost_metrics"."cloud_connection_id" IS NULL;

UPDATE "cost_metrics"
SET "billing_source" = CASE
  WHEN "source_metric" IN ('FOCUSBilledCost', 'FOCUSSampleBilledCost', 'OCI_FOCUS_BILLED_COST') THEN 'FOCUS'::"CostBillingSource"
  ELSE 'LEGACY'::"CostBillingSource"
END;

CREATE INDEX "cost_metrics_tenant_id_cloud_connection_id_billing_source_charge_period_start_idx"
  ON "cost_metrics"("tenant_id", "cloud_connection_id", "billing_source", "charge_period_start");

ALTER TABLE "cost_metrics"
  ADD CONSTRAINT "cost_metrics_cloud_connection_id_fkey"
  FOREIGN KEY ("cloud_connection_id") REFERENCES "cloud_connections"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

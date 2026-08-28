-- Add the remaining percentile exposed by the technical-metrics selector.
-- This is a separate migration because 202608240003 is already deployed.
ALTER TABLE "resource_metric_rollups"
  ADD COLUMN IF NOT EXISTS "p90_value" DECIMAL(24,9);

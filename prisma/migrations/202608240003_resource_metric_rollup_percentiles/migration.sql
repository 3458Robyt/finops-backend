-- Reserve percentile columns for a future mergeable percentile sketch. Raw
-- samples remain canonical; the current bounded rollup uses the native
-- percentile stream's average for bucketed rendering and raw drilldown keeps
-- the exact percentile samples available.
ALTER TABLE "resource_metric_rollups"
  ADD COLUMN IF NOT EXISTS "p50_value" DECIMAL(24,9),
  ADD COLUMN IF NOT EXISTS "p95_value" DECIMAL(24,9),
  ADD COLUMN IF NOT EXISTS "p99_value" DECIMAL(24,9);

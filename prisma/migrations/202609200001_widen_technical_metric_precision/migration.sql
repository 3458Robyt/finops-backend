-- Technical providers expose cumulative counters that can exceed DECIMAL(24,9)
-- while still requiring exact decimal storage. Keep raw samples and both
-- projections on the same wider precision so ingestion and rollups cannot
-- fail on a valid provider value.
ALTER TABLE "resource_metric_samples"
  ALTER COLUMN "value" TYPE DECIMAL(38,9);

ALTER TABLE "resource_metric_stream_summaries"
  ALTER COLUMN "latest_value" TYPE DECIMAL(38,9);

ALTER TABLE "resource_metric_rollups"
  ALTER COLUMN "sum_value" TYPE DECIMAL(38,9),
  ALTER COLUMN "avg_value" TYPE DECIMAL(38,9),
  ALTER COLUMN "min_value" TYPE DECIMAL(38,9),
  ALTER COLUMN "p50_value" TYPE DECIMAL(38,9),
  ALTER COLUMN "p90_value" TYPE DECIMAL(38,9),
  ALTER COLUMN "p95_value" TYPE DECIMAL(38,9),
  ALTER COLUMN "p99_value" TYPE DECIMAL(38,9),
  ALTER COLUMN "max_value" TYPE DECIMAL(38,9),
  ALTER COLUMN "latest_value" TYPE DECIMAL(38,9);

-- Preserve the provider-native statistic for every technical metric sample.
-- Existing rows are classified from persisted provider metadata and fall back
-- to MEAN only when the source did not preserve a statistic.

CREATE TYPE "MetricStatistic" AS ENUM (
  'MEAN',
  'MIN',
  'MAX',
  'P50',
  'P90',
  'P95',
  'P99',
  'SUM',
  'COUNT',
  'RATE',
  'LATEST'
);

ALTER TABLE "resource_metric_samples"
  ADD COLUMN "statistic" "MetricStatistic" NOT NULL DEFAULT 'MEAN';

UPDATE "resource_metric_samples"
SET "statistic" = CASE
  WHEN upper(COALESCE("raw_metric"->>'stat', '')) IN ('AVERAGE', 'AVG', 'MEAN') THEN 'MEAN'::"MetricStatistic"
  WHEN upper(COALESCE("raw_metric"->>'stat', '')) IN ('MINIMUM', 'MIN') THEN 'MIN'::"MetricStatistic"
  WHEN upper(COALESCE("raw_metric"->>'stat', '')) IN ('MAXIMUM', 'MAX') THEN 'MAX'::"MetricStatistic"
  WHEN upper(COALESCE("raw_metric"->>'stat', '')) IN ('SUM') THEN 'SUM'::"MetricStatistic"
  WHEN upper(COALESCE("raw_metric"->>'stat', '')) IN ('SAMPLECOUNT', 'COUNT') THEN 'COUNT'::"MetricStatistic"
  WHEN COALESCE("raw_metric"->>'query', '') ~* 'percentile\s*\(\s*0\.5\s*\)' THEN 'P50'::"MetricStatistic"
  WHEN COALESCE("raw_metric"->>'query', '') ~* 'percentile\s*\(\s*0\.9\s*\)' THEN 'P90'::"MetricStatistic"
  WHEN COALESCE("raw_metric"->>'query', '') ~* 'percentile\s*\(\s*0\.95\s*\)' THEN 'P95'::"MetricStatistic"
  WHEN COALESCE("raw_metric"->>'query', '') ~* 'percentile\s*\(\s*0\.99\s*\)' THEN 'P99'::"MetricStatistic"
  ELSE 'MEAN'::"MetricStatistic"
END;

DROP INDEX IF EXISTS "resource_metric_samples_cloud_connection_id_external_resource_id_metric_name_sampled_at_key";
DROP INDEX IF EXISTS "resource_metric_samples_tenant_id_metric_name_sampled_at_idx";
DROP INDEX IF EXISTS "resource_metric_samples_tenant_id_external_resource_id_metric_name_sampled_at_idx";

CREATE UNIQUE INDEX "resource_metric_samples_cloud_connection_id_external_resource_id_metric_name_statistic_granularity_seconds_sampled_at_key"
  ON "resource_metric_samples" ("cloud_connection_id", "external_resource_id", "metric_name", "statistic", "granularity_seconds", "sampled_at");

CREATE INDEX "resource_metric_samples_tenant_id_metric_name_statistic_sampled_at_idx"
  ON "resource_metric_samples" ("tenant_id", "metric_name", "statistic", "sampled_at");

CREATE INDEX "resource_metric_samples_tenant_id_external_resource_id_metric_name_statistic_sampled_at_idx"
  ON "resource_metric_samples" ("tenant_id", "external_resource_id", "metric_name", "statistic", "sampled_at");

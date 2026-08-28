-- The existing tenant/metric/statistic/bucket index is the better access path
-- for the selected-metric query. Do not keep a second wide index on this hot
-- projection because every incremental ingestion would maintain both.
DROP INDEX IF EXISTS "resource_metric_rollups_series_filter_idx";

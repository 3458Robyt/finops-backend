-- The scheduler claims connections across tenants before it can establish a
-- tenant context. It only needs read access to the metric catalog, coverage
-- windows and raw samples while building an idempotent schedule.
--
-- Keep the existing tenant policies intact and add a SELECT-only policy for
-- the named scheduler worker. This avoids granting the API roles access and
-- does not grant background workers write access to these tables.

DROP POLICY IF EXISTS "finops_ingestion_scheduler_metric_coverage_read"
  ON "resource_metric_coverage_windows";
CREATE POLICY "finops_ingestion_scheduler_metric_coverage_read"
  ON "resource_metric_coverage_windows"
  FOR SELECT TO finops_runtime
  USING (
    finops_context_value('app.worker_id') = 'ingestion-scheduler'
  );

DROP POLICY IF EXISTS "finops_ingestion_scheduler_metric_samples_read"
  ON "resource_metric_samples";
CREATE POLICY "finops_ingestion_scheduler_metric_samples_read"
  ON "resource_metric_samples"
  FOR SELECT TO finops_runtime
  USING (
    finops_context_value('app.worker_id') = 'ingestion-scheduler'
  );

-- PostgreSQL evaluates an UPDATE through a visible row set. Permit the
-- reconciler to see only RUNNING rows so its bounded UPDATE policy can close
-- rows selected by the application's configured freshness window.
CREATE POLICY "finops_runtime_process_heartbeat_stale_reconciliation_read"
  ON "runtime_process_heartbeats"
  FOR SELECT TO finops_runtime
  USING (
    (SELECT current_setting('app.worker_id', true)) = 'process-heartbeat-reconciler'
    AND "status" = 'RUNNING'
  );

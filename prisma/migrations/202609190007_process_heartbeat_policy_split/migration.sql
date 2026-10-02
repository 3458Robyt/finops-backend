-- Split process-heartbeat policies by command so the maintenance reconciler
-- can close stale rows without gaining insert/delete rights over other
-- processes.
DROP POLICY IF EXISTS "finops_runtime_process_heartbeat_owner" ON "runtime_process_heartbeats";
DROP POLICY IF EXISTS "finops_runtime_process_heartbeat_stale_reconciliation" ON "runtime_process_heartbeats";
DROP POLICY IF EXISTS "finops_runtime_process_heartbeat_stale_reconciliation_read" ON "runtime_process_heartbeats";

CREATE POLICY "finops_runtime_process_heartbeat_owner_select"
  ON "runtime_process_heartbeats"
  FOR SELECT TO finops_runtime
  USING (
    "process_id" = NULLIF((SELECT current_setting('app.worker_id', true)), '')
    OR (
      (SELECT current_setting('app.worker_id', true)) = 'process-heartbeat-reconciler'
      AND "status" = 'RUNNING'
    )
  );

CREATE POLICY "finops_runtime_process_heartbeat_owner_insert"
  ON "runtime_process_heartbeats"
  FOR INSERT TO finops_runtime
  WITH CHECK ("process_id" = NULLIF((SELECT current_setting('app.worker_id', true)), ''));

CREATE POLICY "finops_runtime_process_heartbeat_owner_update"
  ON "runtime_process_heartbeats"
  FOR UPDATE TO finops_runtime
  USING (
    "process_id" = NULLIF((SELECT current_setting('app.worker_id', true)), '')
    OR (
      (SELECT current_setting('app.worker_id', true)) = 'process-heartbeat-reconciler'
      AND "status" = 'RUNNING'
    )
  )
  WITH CHECK (
    "process_id" = NULLIF((SELECT current_setting('app.worker_id', true)), '')
    OR (
      (SELECT current_setting('app.worker_id', true)) = 'process-heartbeat-reconciler'
      AND "status" = 'STOPPED'
    )
  );

CREATE POLICY "finops_runtime_process_heartbeat_owner_delete"
  ON "runtime_process_heartbeats"
  FOR DELETE TO finops_runtime
  USING ("process_id" = NULLIF((SELECT current_setting('app.worker_id', true)), ''));

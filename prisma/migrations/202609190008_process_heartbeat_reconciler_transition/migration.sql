-- PostgreSQL checks the resulting row through SELECT during an UPDATE. Keep
-- the reconciler able to see the STOPPED result of its own bounded transition.
DROP POLICY IF EXISTS "finops_runtime_process_heartbeat_owner_select" ON "runtime_process_heartbeats";

CREATE POLICY "finops_runtime_process_heartbeat_owner_select"
  ON "runtime_process_heartbeats"
  FOR SELECT TO finops_runtime
  USING (
    "process_id" = NULLIF((SELECT current_setting('app.worker_id', true)), '')
    OR (SELECT current_setting('app.worker_id', true)) = 'process-heartbeat-reconciler'
  );

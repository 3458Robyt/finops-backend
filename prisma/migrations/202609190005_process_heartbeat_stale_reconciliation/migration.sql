-- Allow the process bootstrap to close rows left RUNNING after an abrupt stop.
-- The policy is limited to the fixed maintenance worker and to the status-only
-- transition performed by PrismaProcessHeartbeatRepository.markStale().
CREATE POLICY "finops_runtime_process_heartbeat_stale_reconciliation"
  ON "runtime_process_heartbeats"
  FOR UPDATE TO finops_runtime
  USING (
    (SELECT current_setting('app.worker_id', true)) = 'process-heartbeat-reconciler'
    AND "status" = 'RUNNING'
  )
  WITH CHECK (
    (SELECT current_setting('app.worker_id', true)) = 'process-heartbeat-reconciler'
    AND "status" = 'STOPPED'
  );

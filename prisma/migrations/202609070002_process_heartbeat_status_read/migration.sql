-- The API must inspect global worker liveness while process-owned writes and
-- direct worker reads remain isolated by app.worker_id.
CREATE POLICY "finops_runtime_process_heartbeat_status_read"
  ON "runtime_process_heartbeats"
  FOR SELECT TO finops_runtime
  USING ((SELECT current_setting('app.worker_id', true)) = 'recommendation-analysis-status');

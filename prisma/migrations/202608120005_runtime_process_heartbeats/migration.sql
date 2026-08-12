-- Durable liveness for API, worker and scheduler processes. This table contains no
-- tenant data and is writable only by a process using its own worker context.
CREATE TABLE "runtime_process_heartbeats" (
  "process_id" TEXT NOT NULL,
  "process_role" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "pid" INTEGER,
  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "last_heartbeat_at" TIMESTAMPTZ(6) NOT NULL,
  "stopped_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runtime_process_heartbeats_pkey" PRIMARY KEY ("process_id"),
  CONSTRAINT "runtime_process_heartbeats_status_check" CHECK ("status" IN ('RUNNING', 'STOPPED'))
);

CREATE INDEX "runtime_process_heartbeats_role_status_last_heartbeat_idx"
  ON "runtime_process_heartbeats"("process_role", "status", "last_heartbeat_at");

ALTER TABLE "runtime_process_heartbeats" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "finops_runtime_process_heartbeat_owner"
  ON "runtime_process_heartbeats"
  FOR ALL TO finops_runtime
  USING ("process_id" = NULLIF(current_setting('app.worker_id', true), ''))
  WITH CHECK ("process_id" = NULLIF(current_setting('app.worker_id', true), ''));

REVOKE ALL ON TABLE "runtime_process_heartbeats" FROM PUBLIC;
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format('REVOKE ALL PRIVILEGES ON TABLE %I FROM %I', 'runtime_process_heartbeats', role_name);
    END IF;
  END LOOP;
END
$$;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "runtime_process_heartbeats" TO finops_runtime;

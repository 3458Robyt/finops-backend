-- Versiona el contrato de ingesta de cada job para que cambiar estadísticas
-- o definiciones vuelva a encolar las ventanas necesarias sin duplicar jobs
-- de la misma configuración.
ALTER TABLE "ingestion_jobs"
  ADD COLUMN IF NOT EXISTS "configuration_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "request_context" JSONB;

CREATE INDEX IF NOT EXISTS "ingestion_jobs_configuration_window_idx"
  ON "ingestion_jobs" ("cloud_connection_id", "source_type", "configuration_hash", "target_start", "target_end");

CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_jobs_configuration_window_active_key"
  ON "ingestion_jobs" ("cloud_connection_id", "source_type", "configuration_hash", "target_start", "target_end")
  WHERE "configuration_hash" IS NOT NULL
    AND "status" IN ('PENDING', 'RUNNING', 'SUCCESS');

-- Keep credential replacement safe: a new key is a candidate until a signed
-- provider request succeeds. The previous ACTIVE credential remains usable.
ALTER TYPE "CredentialStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "CredentialStatus" ADD VALUE IF NOT EXISTS 'INVALID';

ALTER TABLE "cloud_connections"
  ADD COLUMN IF NOT EXISTS "last_validation_attempt_at" TIMESTAMPTZ(6);

ALTER TABLE "cloud_connection_credentials"
  ADD COLUMN IF NOT EXISTS "validation_status" TEXT;

ALTER TABLE "cloud_connection_credentials"
  ADD COLUMN IF NOT EXISTS "validation_message" TEXT;

ALTER TABLE "cloud_connection_credentials"
  ADD COLUMN IF NOT EXISTS "validation_attempted_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "cloud_connection_credentials_validation_status_idx"
  ON "cloud_connection_credentials" ("cloud_connection_id", "validation_status", "validation_attempted_at");

COMMENT ON COLUMN "cloud_connections"."last_validation_attempt_at"
  IS 'Último intento de validación; no implica que la autenticación haya sido aceptada.';

COMMENT ON COLUMN "cloud_connection_credentials"."validation_message"
  IS 'Mensaje operacional seguro de la última validación; nunca contiene el secreto.';

-- Store a non-secret identity for a credential so repeated submissions are
-- idempotent without comparing encrypted payloads (which intentionally use a
-- fresh IV on every write).
ALTER TABLE "cloud_connection_credentials"
  ADD COLUMN IF NOT EXISTS "key_fingerprint" TEXT;

CREATE INDEX IF NOT EXISTS "cloud_connection_credentials_connection_purpose_fingerprint_idx"
  ON "cloud_connection_credentials" ("cloud_connection_id", "purpose", "key_fingerprint");

-- The same provider key must not be represented by multiple live candidates.
-- NULL fingerprints remain allowed for historical/non-OCI credentials until
-- the reconciliation script can derive their identity safely.
CREATE UNIQUE INDEX IF NOT EXISTS "cloud_connection_credentials_live_identity_key"
  ON "cloud_connection_credentials" (
    "cloud_connection_id",
    "purpose",
    COALESCE("external_principal_id", ''),
    COALESCE("key_fingerprint", '')
  )
  WHERE "status" IN ('PENDING', 'ACTIVE', 'INVALID')
    AND "key_fingerprint" IS NOT NULL;

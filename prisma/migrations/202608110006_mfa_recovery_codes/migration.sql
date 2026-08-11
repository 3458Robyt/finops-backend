CREATE TABLE "mfa_recovery_codes" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mfa_recovery_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key"
  ON "mfa_recovery_codes"("code_hash");
CREATE INDEX "mfa_recovery_codes_user_id_revoked_at_used_at_idx"
  ON "mfa_recovery_codes"("user_id", "revoked_at", "used_at");
CREATE INDEX "mfa_recovery_codes_user_id_batch_id_idx"
  ON "mfa_recovery_codes"("user_id", "batch_id");

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I FROM %I', 'mfa_recovery_codes', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mfa_recovery_codes" TO finops_runtime;

ALTER TABLE "mfa_recovery_codes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_mfa_recovery_code_isolation ON "mfa_recovery_codes"
  FOR ALL TO finops_runtime
  USING (
    user_id = finops_current_user_id()
    OR user_id = finops_mfa_challenge_user_id()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = mfa_recovery_codes.user_id
        AND u.tenant_id = finops_active_tenant_id()
    )
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR user_id = finops_mfa_challenge_user_id()
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = mfa_recovery_codes.user_id
        AND u.tenant_id = finops_active_tenant_id()
    )
  );

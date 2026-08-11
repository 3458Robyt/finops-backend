-- Close the authentication lifecycle without putting refresh credentials in
-- the browser storage. Access JWTs remain short-lived; refresh credentials are
-- opaque, one-use values persisted only as SHA-256 hashes.

ALTER TABLE "auth_sessions"
  ADD COLUMN "tenant_id" TEXT;

UPDATE "auth_sessions" s
SET "tenant_id" = u."tenant_id"
FROM "users" u
WHERE u."id" = s."user_id"
  AND s."tenant_id" IS NULL;

ALTER TABLE "auth_sessions"
  ALTER COLUMN "tenant_id" SET NOT NULL;

ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "auth_sessions_tenant_id_revoked_at_idx"
  ON "auth_sessions"("tenant_id", "revoked_at");

CREATE TABLE "auth_refresh_tokens" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "family_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "ip_address" TEXT,
  "user_agent" TEXT,
  CONSTRAINT "auth_refresh_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auth_refresh_tokens_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "auth_refresh_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "auth_refresh_tokens_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "auth_refresh_tokens_token_hash_key"
  ON "auth_refresh_tokens"("token_hash");
CREATE INDEX "auth_refresh_tokens_session_id_revoked_at_idx"
  ON "auth_refresh_tokens"("session_id", "revoked_at");
CREATE INDEX "auth_refresh_tokens_user_id_revoked_at_expires_at_idx"
  ON "auth_refresh_tokens"("user_id", "revoked_at", "expires_at");
CREATE INDEX "auth_refresh_tokens_family_id_revoked_at_idx"
  ON "auth_refresh_tokens"("family_id", "revoked_at");

CREATE TYPE "MfaChallengePurpose" AS ENUM ('LOGIN', 'ENROLLMENT');

CREATE TABLE "password_reset_tokens" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip_address" TEXT,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "password_reset_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key"
  ON "password_reset_tokens"("token_hash");
CREATE INDEX "password_reset_tokens_user_id_expires_at_idx"
  ON "password_reset_tokens"("user_id", "expires_at");

CREATE TABLE "user_mfa" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "encrypted_secret" TEXT NOT NULL,
  "encryption_iv" TEXT NOT NULL,
  "encryption_auth_tag" TEXT NOT NULL,
  "encryption_algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
  "encryption_key_version" TEXT NOT NULL DEFAULT 'v1',
  "enabled_at" TIMESTAMPTZ(6),
  "last_used_step" BIGINT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_mfa_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_mfa_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "user_mfa_user_id_key" ON "user_mfa"("user_id");

CREATE TABLE "mfa_challenges" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "purpose" "MfaChallengePurpose" NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip_address" TEXT,
  "user_agent" TEXT,
  CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mfa_challenges_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "mfa_challenges_token_hash_key"
  ON "mfa_challenges"("token_hash");
CREATE INDEX "mfa_challenges_user_id_purpose_expires_at_idx"
  ON "mfa_challenges"("user_id", "purpose", "expires_at");

-- The application reaches these tables through finops_runtime only. The API
-- roles must not be able to query or mutate credentials directly.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I FROM %I', 'auth_refresh_tokens', role_name);
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I FROM %I', 'password_reset_tokens', role_name);
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I FROM %I', 'user_mfa', role_name);
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %I FROM %I', 'mfa_challenges', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "auth_refresh_tokens" TO finops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "password_reset_tokens" TO finops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user_mfa" TO finops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mfa_challenges" TO finops_runtime;

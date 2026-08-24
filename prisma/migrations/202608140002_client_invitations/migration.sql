-- One-time, hashed invitations for restricted client portal accounts.
-- The plaintext code never reaches the database and is returned only once.
CREATE TABLE "client_invitations" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "invited_name" TEXT,
  "role" "UserRole" NOT NULL DEFAULT 'CLIENT_VIEWER',
  "token_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "client_invitations_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "client_invitations_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "client_invitations_token_hash_key" ON "client_invitations"("token_hash");
CREATE INDEX "client_invitations_tenant_expiry_consumed_idx"
  ON "client_invitations"("tenant_id", "expires_at", "consumed_at");
CREATE INDEX "client_invitations_email_consumed_idx"
  ON "client_invitations"("email", "consumed_at");

ALTER TABLE "client_invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "finops_client_invitation_isolation" ON "client_invitations"
  FOR ALL TO finops_runtime
  USING (
    current_setting('app.user_role', true) = 'MASTER_ADMIN'
    OR "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')
    OR "token_hash" = NULLIF(current_setting('app.client_invitation_token_hash', true), '')
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'MASTER_ADMIN'
    OR "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')
    OR "token_hash" = NULLIF(current_setting('app.client_invitation_token_hash', true), '')
  );

-- Allow the public acceptance flow to create only the client user represented
-- by the valid one-time invitation. Staff/master creation remains unchanged.
DROP POLICY IF EXISTS "finops_user_management" ON "users";
CREATE POLICY "finops_user_management" ON "users"
  FOR INSERT TO finops_runtime
  WITH CHECK (
    current_setting('app.user_role', true) = 'MASTER_ADMIN'
    OR (
      "role" IN ('CLIENT_APPROVER', 'CLIENT_VIEWER')
      AND "email" = (
        SELECT ci."email"
        FROM "client_invitations" ci
        WHERE ci."token_hash" = NULLIF(current_setting('app.client_invitation_token_hash', true), '')
          AND ci."consumed_at" IS NULL
          AND ci."revoked_at" IS NULL
          AND ci."expires_at" > CURRENT_TIMESTAMP
        LIMIT 1
      )
      AND "tenant_id" = (
        SELECT ci."tenant_id"
        FROM "client_invitations" ci
        WHERE ci."token_hash" = NULLIF(current_setting('app.client_invitation_token_hash', true), '')
          AND ci."consumed_at" IS NULL
          AND ci."revoked_at" IS NULL
          AND ci."expires_at" > CURRENT_TIMESTAMP
        LIMIT 1
      )
    )
  );

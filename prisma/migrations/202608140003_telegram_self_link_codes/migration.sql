-- Short-lived, one-time codes for self-linking a user's Telegram chat.
-- Only the SHA-256 hash is persisted; the raw code is returned once to the
-- authenticated user and is consumed by the authenticated Telegram webhook.
CREATE TABLE "telegram_link_codes" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_link_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "telegram_link_codes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "telegram_link_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "telegram_link_codes_token_hash_key"
  ON "telegram_link_codes"("token_hash");
CREATE INDEX "telegram_link_codes_tenant_user_expiry_consumed_idx"
  ON "telegram_link_codes"("tenant_id", "user_id", "expires_at", "consumed_at");

ALTER TABLE "telegram_link_codes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "finops_telegram_link_code_isolation" ON "telegram_link_codes"
  FOR ALL TO finops_runtime
  USING (
    current_setting('app.user_role', true) = 'MASTER_ADMIN'
    OR (
      "tenant_id" = finops_active_tenant_id()
      AND "user_id" = finops_current_user_id()
    )
    OR (
      finops_context_value('app.worker_id') = 'telegram-webhook'
      AND "token_hash" = NULLIF(current_setting('app.telegram_link_token_hash', true), '')
    )
  )
  WITH CHECK (
    current_setting('app.user_role', true) = 'MASTER_ADMIN'
    OR (
      "tenant_id" = finops_active_tenant_id()
      AND "user_id" = finops_current_user_id()
    )
    OR (
      finops_context_value('app.worker_id') = 'telegram-webhook'
      AND "token_hash" = NULLIF(current_setting('app.telegram_link_token_hash', true), '')
    )
  );

-- The webhook is authenticated before this worker context is created. It must
-- resolve the globally unique Telegram chat id before it knows the tenant, and
-- it must be able to persist the resulting tenant-scoped interaction log.
DROP POLICY IF EXISTS finops_tenant_isolation ON telegram_chat_links;
CREATE POLICY finops_telegram_chat_link_isolation ON telegram_chat_links
  FOR ALL TO finops_runtime
  USING (
    tenant_id = finops_active_tenant_id()
    OR finops_context_value('app.worker_id') = 'telegram-webhook'
  )
  WITH CHECK (
    tenant_id = finops_active_tenant_id()
    OR finops_context_value('app.worker_id') = 'telegram-webhook'
  );

DROP POLICY IF EXISTS finops_telegram_interaction_isolation ON telegram_interaction_logs;
CREATE POLICY finops_telegram_interaction_isolation ON telegram_interaction_logs
  FOR ALL TO finops_runtime
  USING (
    tenant_id = finops_active_tenant_id()
    OR finops_context_value('app.worker_id') = 'telegram-webhook'
  )
  WITH CHECK (
    tenant_id = finops_active_tenant_id()
    OR finops_context_value('app.worker_id') = 'telegram-webhook'
  );

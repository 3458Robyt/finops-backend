-- Messaging hardening: one active Telegram link per platform user, persisted
-- user preferences, and an idempotent durable inbound webhook queue.

CREATE TYPE "TelegramInboundUpdateStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

ALTER TABLE "telegram_chat_links"
  ADD COLUMN "active_tenant_id" TEXT;

CREATE INDEX "telegram_chat_links_active_tenant_id_idx"
  ON "telegram_chat_links"("active_tenant_id");

ALTER TABLE "telegram_chat_links"
  ADD CONSTRAINT "telegram_chat_links_active_tenant_id_fkey"
  FOREIGN KEY ("active_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve historical links, but make the newest active link authoritative if
-- old test data accidentally linked the same platform user more than once.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "user_id" ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC) AS position
  FROM "telegram_chat_links"
  WHERE "status" = 'ACTIVE'
)
UPDATE "telegram_chat_links" AS links
SET "status" = 'DISABLED', "disabled_at" = COALESCE("disabled_at", CURRENT_TIMESTAMP), "updated_at" = CURRENT_TIMESTAMP
FROM ranked
WHERE links."id" = ranked."id" AND ranked.position > 1;

CREATE UNIQUE INDEX "telegram_chat_links_one_active_user_idx"
  ON "telegram_chat_links"("user_id")
  WHERE "status" = 'ACTIVE';

CREATE TABLE "user_messaging_preferences" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "email_enabled" BOOLEAN NOT NULL DEFAULT true,
  "telegram_enabled" BOOLEAN NOT NULL DEFAULT false,
  "operational_alerts" BOOLEAN NOT NULL DEFAULT true,
  "recommendation_alerts" BOOLEAN NOT NULL DEFAULT true,
  "financial_alerts" BOOLEAN NOT NULL DEFAULT true,
  "executive_summaries" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_messaging_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_messaging_preferences_user_id_key"
  ON "user_messaging_preferences"("user_id");

ALTER TABLE "user_messaging_preferences"
  ADD CONSTRAINT "user_messaging_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "telegram_inbound_updates" (
  "id" TEXT NOT NULL,
  "update_id" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "TelegramInboundUpdateStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ(6),
  "locked_by" TEXT,
  "error_message" TEXT,
  "processed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_inbound_updates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_inbound_updates_update_id_key"
  ON "telegram_inbound_updates"("update_id");

CREATE INDEX "telegram_inbound_updates_status_next_attempt_at_locked_at_created_at_idx"
  ON "telegram_inbound_updates"("status", "next_attempt_at", "locked_at", "created_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "user_messaging_preferences" TO finops_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "telegram_inbound_updates" TO finops_runtime;
REVOKE ALL ON TABLE "user_messaging_preferences" FROM anon, authenticated, service_role;
REVOKE ALL ON TABLE "telegram_inbound_updates" FROM anon, authenticated, service_role;

ALTER TABLE "user_messaging_preferences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "finops_messaging_preferences_isolation" ON "user_messaging_preferences"
  FOR ALL TO finops_runtime
  USING ("user_id" = (SELECT finops_current_user_id()))
  WITH CHECK ("user_id" = (SELECT finops_current_user_id()));

ALTER TABLE "telegram_inbound_updates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "finops_telegram_inbound_worker_access" ON "telegram_inbound_updates"
  FOR ALL TO finops_runtime
  USING ((SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%')
  WITH CHECK ((SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%');

-- Self-link codes can be consumed by the durable inbound worker after the
-- webhook has returned. Keep the token-hash check, but allow every dedicated
-- Telegram worker rather than only the legacy synchronous webhook id.
DROP POLICY IF EXISTS "finops_telegram_link_code_isolation" ON "telegram_link_codes";
CREATE POLICY "finops_telegram_link_code_isolation" ON "telegram_link_codes"
  FOR ALL TO finops_runtime
  USING (
    (SELECT current_setting('app.user_role', true)) = 'MASTER_ADMIN'
    OR (
      "tenant_id" = (SELECT finops_active_tenant_id())
      AND "user_id" = (SELECT finops_current_user_id())
    )
    OR (
      (SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%'
      AND "token_hash" = NULLIF((SELECT current_setting('app.telegram_link_token_hash', true)), '')
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.user_role', true)) = 'MASTER_ADMIN'
    OR (
      "tenant_id" = (SELECT finops_active_tenant_id())
      AND "user_id" = (SELECT finops_current_user_id())
    )
    OR (
      (SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%'
      AND "token_hash" = NULLIF((SELECT current_setting('app.telegram_link_token_hash', true)), '')
    )
  );

DROP POLICY IF EXISTS "finops_telegram_chat_link_isolation" ON "telegram_chat_links";
CREATE POLICY "finops_telegram_chat_link_isolation" ON "telegram_chat_links"
  FOR ALL TO finops_runtime
  USING (
    "tenant_id" = (SELECT finops_active_tenant_id())
    OR "active_tenant_id" = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%'
  )
  WITH CHECK (
    "tenant_id" = (SELECT finops_active_tenant_id())
    OR "active_tenant_id" = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%'
  );

DROP POLICY IF EXISTS "finops_telegram_interaction_isolation" ON "telegram_interaction_logs";
CREATE POLICY "finops_telegram_interaction_isolation" ON "telegram_interaction_logs"
  FOR ALL TO finops_runtime
  USING (
    "tenant_id" = (SELECT finops_active_tenant_id())
    OR ("tenant_id" IS NULL AND (SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%')
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%'
  )
  WITH CHECK (
    "tenant_id" = (SELECT finops_active_tenant_id())
    OR ("tenant_id" IS NULL AND (SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%')
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'telegram-%'
  );

DROP POLICY IF EXISTS "finops_tenant_isolation" ON "outbound_message_deliveries";
CREATE POLICY "finops_tenant_isolation" ON "outbound_message_deliveries"
  FOR ALL TO finops_runtime
  USING (
    "tenant_id" = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) = 'message-scheduler'
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'message-%'
  )
  WITH CHECK (
    "tenant_id" = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) = 'message-scheduler'
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'message-%'
  );

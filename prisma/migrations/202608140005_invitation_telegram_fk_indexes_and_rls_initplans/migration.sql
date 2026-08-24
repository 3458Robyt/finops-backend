-- Cover the foreign keys introduced by the client portal and Telegram
-- self-linking tables, and keep their RLS context lookups as statement-level
-- initplans instead of evaluating them once per row.
CREATE INDEX IF NOT EXISTS "client_invitations_created_by_user_id_idx"
  ON "client_invitations" ("created_by_user_id");

CREATE INDEX IF NOT EXISTS "telegram_link_codes_user_id_idx"
  ON "telegram_link_codes" ("user_id");

DROP POLICY IF EXISTS "finops_client_invitation_isolation" ON "client_invitations";
CREATE POLICY "finops_client_invitation_isolation" ON "client_invitations"
  FOR ALL TO finops_runtime
  USING (
    (SELECT current_setting('app.user_role', true)) = 'MASTER_ADMIN'
    OR "tenant_id" = NULLIF((SELECT current_setting('app.tenant_id', true)), '')
    OR "token_hash" = NULLIF((SELECT current_setting('app.client_invitation_token_hash', true)), '')
  )
  WITH CHECK (
    (SELECT current_setting('app.user_role', true)) = 'MASTER_ADMIN'
    OR "tenant_id" = NULLIF((SELECT current_setting('app.tenant_id', true)), '')
    OR "token_hash" = NULLIF((SELECT current_setting('app.client_invitation_token_hash', true)), '')
  );

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
      (SELECT finops_context_value('app.worker_id')) = 'telegram-webhook'
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
      (SELECT finops_context_value('app.worker_id')) = 'telegram-webhook'
      AND "token_hash" = NULLIF((SELECT current_setting('app.telegram_link_token_hash', true)), '')
    )
  );

DROP POLICY IF EXISTS "finops_user_management" ON "users";
CREATE POLICY "finops_user_management" ON "users"
  FOR INSERT TO finops_runtime
  WITH CHECK (
    (SELECT current_setting('app.user_role', true)) = 'MASTER_ADMIN'
    OR (
      "role" IN ('CLIENT_APPROVER', 'CLIENT_VIEWER')
      AND "email" = (
        SELECT ci."email"
        FROM "client_invitations" ci
        WHERE ci."token_hash" = NULLIF((SELECT current_setting('app.client_invitation_token_hash', true)), '')
          AND ci."consumed_at" IS NULL
          AND ci."revoked_at" IS NULL
          AND ci."expires_at" > CURRENT_TIMESTAMP
        LIMIT 1
      )
      AND "tenant_id" = (
        SELECT ci."tenant_id"
        FROM "client_invitations" ci
        WHERE ci."token_hash" = NULLIF((SELECT current_setting('app.client_invitation_token_hash', true)), '')
          AND ci."consumed_at" IS NULL
          AND ci."revoked_at" IS NULL
          AND ci."expires_at" > CURRENT_TIMESTAMP
        LIMIT 1
      )
    )
  );

DROP POLICY IF EXISTS "finops_runtime_process_heartbeat_owner" ON "runtime_process_heartbeats";
CREATE POLICY "finops_runtime_process_heartbeat_owner" ON "runtime_process_heartbeats"
  FOR ALL TO finops_runtime
  USING ("process_id" = NULLIF((SELECT current_setting('app.worker_id', true)), ''))
  WITH CHECK ("process_id" = NULLIF((SELECT current_setting('app.worker_id', true)), ''));

DROP POLICY IF EXISTS finops_telegram_chat_link_isolation ON telegram_chat_links;
CREATE POLICY finops_telegram_chat_link_isolation ON telegram_chat_links
  FOR ALL TO finops_runtime
  USING (
    tenant_id = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) = 'telegram-webhook'
  )
  WITH CHECK (
    tenant_id = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) = 'telegram-webhook'
  );

DROP POLICY IF EXISTS finops_telegram_interaction_isolation ON telegram_interaction_logs;
CREATE POLICY finops_telegram_interaction_isolation ON telegram_interaction_logs
  FOR ALL TO finops_runtime
  USING (
    tenant_id = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) = 'telegram-webhook'
  )
  WITH CHECK (
    tenant_id = (SELECT finops_active_tenant_id())
    OR (SELECT finops_context_value('app.worker_id')) = 'telegram-webhook'
  );

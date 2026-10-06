-- Scope user channel preferences to the tenant currently selected in the portal.
ALTER TABLE "user_messaging_preferences"
  ADD COLUMN "tenant_id" TEXT;

UPDATE "user_messaging_preferences" AS preferences
SET "tenant_id" = users."tenant_id"
FROM "users" AS users
WHERE users."id" = preferences."user_id";

ALTER TABLE "user_messaging_preferences"
  ALTER COLUMN "tenant_id" SET NOT NULL;

DROP INDEX "user_messaging_preferences_user_id_key";
CREATE UNIQUE INDEX "user_messaging_preferences_tenant_user_key"
  ON "user_messaging_preferences"("tenant_id", "user_id");

ALTER TABLE "user_messaging_preferences"
  ADD CONSTRAINT "user_messaging_preferences_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP POLICY IF EXISTS "finops_messaging_preferences_isolation" ON "user_messaging_preferences";
CREATE POLICY "finops_messaging_preferences_isolation" ON "user_messaging_preferences"
  FOR ALL TO finops_runtime
  USING (
    ("tenant_id" = (SELECT finops_active_tenant_id())
      AND "user_id" = (SELECT finops_current_user_id()))
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'message-%'
  )
  WITH CHECK (
    ("tenant_id" = (SELECT finops_active_tenant_id())
      AND "user_id" = (SELECT finops_current_user_id()))
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'message-%'
  );

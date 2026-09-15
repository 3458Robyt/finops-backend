-- Preserve decision provenance and notification response timestamps for the
-- objective 4/5 evidence model. Historical decision roles remain NULL rather
-- than being inferred from a user's current role.
ALTER TABLE "recommendation_decisions"
  ADD COLUMN "actor_role" "UserRole";

ALTER TABLE "in_app_notifications"
  ADD COLUMN "read_at" TIMESTAMPTZ(6),
  ADD COLUMN "dismissed_at" TIMESTAMPTZ(6);

CREATE INDEX "recommendation_decisions_actor_role_created_at_idx"
  ON "recommendation_decisions" ("actor_role", "created_at");

CREATE INDEX "in_app_notifications_response_idx"
  ON "in_app_notifications" ("tenant_id", "status", "read_at", "created_at");

-- This is an explicit approximation for old READ rows only. New rows use the
-- exact transition timestamp from the application.
UPDATE "in_app_notifications"
SET "read_at" = "updated_at"
WHERE "status" = 'READ' AND "read_at" IS NULL;

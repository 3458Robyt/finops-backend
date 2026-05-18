CREATE TYPE "InAppNotificationType" AS ENUM ('SAVINGS_REMINDER');

CREATE TYPE "InAppNotificationStatus" AS ENUM ('UNREAD', 'READ', 'DISMISSED');

CREATE TABLE "in_app_notifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "recommendation_id" TEXT,
    "type" "InAppNotificationType" NOT NULL,
    "status" "InAppNotificationStatus" NOT NULL DEFAULT 'UNREAD',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "missed_savings_amount" DECIMAL(18,6),
    "estimated_monthly_savings" DECIMAL(18,6),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "generated_for_date" DATE,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "in_app_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "in_app_notifications_tenant_id_user_id_recommendation_id_type_key"
ON "in_app_notifications"("tenant_id", "user_id", "recommendation_id", "type", "generated_for_date");

CREATE INDEX "in_app_notifications_tenant_id_user_id_status_created_at_idx"
ON "in_app_notifications"("tenant_id", "user_id", "status", "created_at");

CREATE INDEX "in_app_notifications_recommendation_id_created_at_idx"
ON "in_app_notifications"("recommendation_id", "created_at");

ALTER TABLE "in_app_notifications"
ADD CONSTRAINT "in_app_notifications_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "in_app_notifications"
ADD CONSTRAINT "in_app_notifications_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "in_app_notifications"
ADD CONSTRAINT "in_app_notifications_recommendation_id_fkey"
FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

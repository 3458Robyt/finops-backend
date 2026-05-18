CREATE TYPE "TelegramChatLinkStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TYPE "TelegramInteractionStatus" AS ENUM ('PROCESSED', 'IGNORED', 'ERROR');

CREATE TABLE "telegram_chat_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "telegram_user_id" TEXT,
    "telegram_username" TEXT,
    "status" "TelegramChatLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "linked_by_user_id" TEXT NOT NULL,
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "telegram_chat_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "telegram_interaction_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "user_id" TEXT,
    "chat_id" TEXT NOT NULL,
    "telegram_user_id" TEXT,
    "telegram_username" TEXT,
    "command" TEXT,
    "status" "TelegramInteractionStatus" NOT NULL,
    "text_preview" VARCHAR(240),
    "error_message" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_interaction_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_chat_links_chat_id_key" ON "telegram_chat_links"("chat_id");
CREATE UNIQUE INDEX "telegram_chat_links_tenant_id_user_id_chat_id_key" ON "telegram_chat_links"("tenant_id", "user_id", "chat_id");
CREATE INDEX "telegram_chat_links_tenant_id_status_idx" ON "telegram_chat_links"("tenant_id", "status");
CREATE INDEX "telegram_chat_links_user_id_status_idx" ON "telegram_chat_links"("user_id", "status");
CREATE INDEX "telegram_interaction_logs_tenant_id_user_id_created_at_idx" ON "telegram_interaction_logs"("tenant_id", "user_id", "created_at");
CREATE INDEX "telegram_interaction_logs_chat_id_created_at_idx" ON "telegram_interaction_logs"("chat_id", "created_at");
CREATE INDEX "telegram_interaction_logs_status_created_at_idx" ON "telegram_interaction_logs"("status", "created_at");

ALTER TABLE "telegram_chat_links" ADD CONSTRAINT "telegram_chat_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_chat_links" ADD CONSTRAINT "telegram_chat_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_chat_links" ADD CONSTRAINT "telegram_chat_links_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telegram_interaction_logs" ADD CONSTRAINT "telegram_interaction_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_interaction_logs" ADD CONSTRAINT "telegram_interaction_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

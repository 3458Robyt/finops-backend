-- Drop the knowledge graph feature. Context summaries remain as the token-saving layer.
DROP TABLE IF EXISTS "agent_knowledge_edges";
DROP TABLE IF EXISTS "agent_knowledge_nodes";

ALTER TABLE "ai_context_traces"
DROP COLUMN IF EXISTS "knowledge_node_ids";

CREATE TYPE "OutboundMessageChannel" AS ENUM ('TELEGRAM', 'EMAIL');
CREATE TYPE "OutboundMessageType" AS ENUM (
  'TEST',
  'SAVINGS_REMINDER',
  'AI_CHAT_RESPONSE',
  'RECOMMENDATION_SUMMARY',
  'EXECUTION_PLAN_READY'
);
CREATE TYPE "OutboundMessageStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "outbound_message_deliveries" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT,
  "recommendation_id" TEXT,
  "channel" "OutboundMessageChannel" NOT NULL,
  "message_type" "OutboundMessageType" NOT NULL,
  "status" "OutboundMessageStatus" NOT NULL DEFAULT 'PENDING',
  "subject" TEXT,
  "preview" TEXT NOT NULL,
  "provider_message_id" TEXT,
  "error_message" TEXT,
  "metadata" JSONB,
  "sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "outbound_message_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbound_message_deliveries_tenant_id_channel_status_created_at_idx"
ON "outbound_message_deliveries"("tenant_id", "channel", "status", "created_at");

CREATE INDEX "outbound_message_deliveries_user_id_created_at_idx"
ON "outbound_message_deliveries"("user_id", "created_at");

CREATE INDEX "outbound_message_deliveries_recommendation_id_created_at_idx"
ON "outbound_message_deliveries"("recommendation_id", "created_at");

ALTER TABLE "outbound_message_deliveries"
ADD CONSTRAINT "outbound_message_deliveries_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "outbound_message_deliveries"
ADD CONSTRAINT "outbound_message_deliveries_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "outbound_message_deliveries"
ADD CONSTRAINT "outbound_message_deliveries_recommendation_id_fkey"
FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

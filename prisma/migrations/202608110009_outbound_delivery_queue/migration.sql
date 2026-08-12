-- Turn outbound message deliveries into a durable, retryable queue.

ALTER TYPE "OutboundMessageStatus" ADD VALUE 'PROCESSING';

ALTER TABLE "outbound_message_deliveries"
  ADD COLUMN "body" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "locked_at" TIMESTAMPTZ(6),
  ADD COLUMN "locked_by" TEXT;

UPDATE "outbound_message_deliveries"
SET "body" = "preview"
WHERE "body" = '';

CREATE INDEX "outbound_message_deliveries_tenant_id_status_next_attempt_at_locked_at_created_at_idx"
  ON "outbound_message_deliveries"("tenant_id", "status", "next_attempt_at", "locked_at", "created_at");

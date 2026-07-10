-- Make recommendation learning recoverable after process failures and idempotent
-- per source event and memory scope. Preserve historical duplicates before adding
-- the unique constraint.
ALTER TABLE "agent_learning_events"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "locked_at" TIMESTAMPTZ(6),
  ADD COLUMN "locked_by" TEXT;

WITH ranked_memories AS (
  SELECT
    "id",
    "source_learning_event_id",
    ROW_NUMBER() OVER (
      PARTITION BY "source_learning_event_id", "scope"
      ORDER BY "created_at" ASC, "id" ASC
    ) AS row_number
  FROM "agent_memory"
  WHERE "source_learning_event_id" IS NOT NULL
)
UPDATE "agent_memory" AS memory
SET
  "source_learning_event_id" = NULL,
  "metadata" = COALESCE(memory."metadata", '{}'::jsonb) || jsonb_build_object(
    'deduplicatedSourceLearningEventId', ranked_memories."source_learning_event_id"
  ),
  "updated_at" = CURRENT_TIMESTAMP
FROM ranked_memories
WHERE memory."id" = ranked_memories."id"
  AND ranked_memories.row_number > 1;

CREATE INDEX "agent_learning_events_status_next_attempt_at_locked_at_created_at_idx"
  ON "agent_learning_events"("status", "next_attempt_at", "locked_at", "created_at");

CREATE UNIQUE INDEX "agent_memory_source_learning_event_id_scope_key"
  ON "agent_memory"("source_learning_event_id", "scope");

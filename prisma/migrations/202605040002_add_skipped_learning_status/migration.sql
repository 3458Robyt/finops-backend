-- AddEnumValue
ALTER TYPE "AgentLearningStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

-- Reclassify external AI timeouts as skipped learning rather than internal errors.
UPDATE "agent_learning_events"
SET "status" = 'SKIPPED'::"AgentLearningStatus"
WHERE "status" = 'ERROR'::"AgentLearningStatus"
  AND lower(coalesce("error_message", '')) LIKE '%timed out%';

UPDATE "recommendation_decisions" d
SET "learning_status" = 'SKIPPED'::"AgentLearningStatus",
    "learning_processed_at" = CURRENT_TIMESTAMP
FROM "agent_learning_events" e
WHERE e."decision_id" = d."id"
  AND e."status" = 'SKIPPED'::"AgentLearningStatus";

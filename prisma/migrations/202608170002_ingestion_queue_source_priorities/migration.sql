-- Give operationally useful jobs a fair chance ahead of long metric backfills.
-- Only pending/recoverable work with the legacy default is reprioritized.
UPDATE "ingestion_jobs"
SET "priority" = CASE "source_type"
  WHEN 'INVENTORY' THEN 10
  WHEN 'BILLING_EXPORT' THEN 20
  WHEN 'TECHNICAL_METRIC' THEN 30
  WHEN 'AGENT_METRIC' THEN 40
  ELSE 100
END
WHERE "status" IN ('PENDING', 'RUNNING')
  AND "priority" = 100;

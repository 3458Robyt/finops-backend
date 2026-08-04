-- Make legacy direct rules explicit 100% destinations without changing their
-- matching criteria, priority, status or historical cost results.
INSERT INTO "cost_allocation_rule_targets" (
  "id", "tenant_id", "rule_id", "percentage", "cost_center", "business_unit", "project", "team", "environment"
)
SELECT md5(id || ':direct-target'), tenant_id, id, 100,
       cost_center, business_unit, project, team, environment
  FROM "cost_allocation_rules"
 WHERE cost_center IS NOT NULL
    OR business_unit IS NOT NULL
    OR project IS NOT NULL
    OR team IS NOT NULL
    OR environment IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

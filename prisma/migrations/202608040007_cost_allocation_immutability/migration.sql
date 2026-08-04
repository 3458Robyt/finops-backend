-- Keep closed financial evidence immutable. A closed period may only transition
-- to REPLACED during an explicit correction; its financial snapshot is never edited.
ALTER TABLE "cost_allocation_closures"
  ADD CONSTRAINT "cost_allocation_closures_id_tenant_id_key"
  UNIQUE ("id", "tenant_id");

ALTER TABLE "cost_allocation_closure_lines"
  DROP CONSTRAINT IF EXISTS "cost_allocation_closure_lines_closure_id_fkey";

ALTER TABLE "cost_allocation_closure_lines"
  ADD CONSTRAINT "cost_allocation_closure_lines_closure_id_tenant_id_fkey"
  FOREIGN KEY ("closure_id", "tenant_id")
  REFERENCES "cost_allocation_closures" ("id", "tenant_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION finops_guard_cost_allocation_closure_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status = 'CLOSED'::"CostAllocationClosureStatus"
     AND NEW.status = 'REPLACED'::"CostAllocationClosureStatus"
     AND NEW.replacement_reason IS NOT NULL
     AND btrim(NEW.replacement_reason) <> ''
     AND NEW.id = OLD.id
     AND NEW.tenant_id = OLD.tenant_id
     AND NEW.period_start = OLD.period_start
     AND NEW.currency = OLD.currency
     AND NEW.version = OLD.version
     AND NEW.source_total = OLD.source_total
     AND NEW.allocated_total = OLD.allocated_total
     AND NEW.shared_total = OLD.shared_total
     AND NEW.unallocated_total = OLD.unallocated_total
     AND NEW.source_hash = OLD.source_hash
     AND NEW.rules_hash = OLD.rules_hash
     AND NEW.results = OLD.results
     AND NEW.closed_by_user_id = OLD.closed_by_user_id
     AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Closed cost allocation closures are immutable';
END;
$$;

DROP TRIGGER IF EXISTS cost_allocation_closures_immutability_guard
  ON "cost_allocation_closures";
CREATE TRIGGER cost_allocation_closures_immutability_guard
  BEFORE UPDATE ON "cost_allocation_closures"
  FOR EACH ROW
  EXECUTE FUNCTION finops_guard_cost_allocation_closure_update();

REVOKE UPDATE, DELETE ON TABLE "cost_allocation_closure_lines" FROM finops_runtime;
REVOKE DELETE ON TABLE "cost_allocation_closures" FROM finops_runtime;

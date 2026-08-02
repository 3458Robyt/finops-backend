-- Enforce tenant consistency for foreign keys that point to another
-- tenant-owned table. RLS protects visibility, while this trigger prevents a
-- valid row from one tenant from referencing a parent row of another tenant.
CREATE OR REPLACE FUNCTION finops_assert_tenant_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  foreign_key record;
  child_value text;
  parent_tenant text;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  FOR foreign_key IN
    SELECT
      parent_ns.nspname AS parent_schema,
      parent.relname AS parent_table,
      child_att.attname AS child_column,
      parent_att.attname AS parent_column
    FROM pg_constraint constraint_row
    JOIN pg_class child ON child.oid = constraint_row.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = constraint_row.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS child_columns(attnum, ord) ON true
    JOIN pg_attribute child_att
      ON child_att.attrelid = child.oid
     AND child_att.attnum = child_columns.attnum
    JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY AS parent_columns(attnum, ord)
      ON parent_columns.ord = child_columns.ord
    JOIN pg_attribute parent_att
      ON parent_att.attrelid = parent.oid
     AND parent_att.attnum = parent_columns.attnum
    WHERE constraint_row.contype = 'f'
      AND child.oid = TG_RELID
      AND EXISTS (
        SELECT 1
        FROM pg_attribute parent_tenant_column
        WHERE parent_tenant_column.attrelid = parent.oid
          AND parent_tenant_column.attname = 'tenant_id'
          AND parent_tenant_column.attnum > 0
          AND NOT parent_tenant_column.attisdropped
      )
  LOOP
    child_value := to_jsonb(NEW) ->> foreign_key.child_column;
    IF child_value IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT tenant_id::text FROM %I.%I WHERE %I::text = $1 LIMIT 1',
      foreign_key.parent_schema,
      foreign_key.parent_table,
      foreign_key.parent_column
    )
    INTO parent_tenant
    USING child_value;

    IF parent_tenant IS NOT NULL AND parent_tenant <> NEW.tenant_id::text THEN
      RAISE EXCEPTION 'Tenant relationship violation on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION finops_assert_tenant_consistency() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_assert_tenant_consistency() TO finops_runtime;

DO $$
DECLARE
  table_name text;
  schema_name text := current_schema();
BEGIN
  FOR table_name IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = schema_name
      AND c.column_name = 'tenant_id'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS finops_tenant_relationship_guard ON %I', table_name);
    EXECUTE format(
      'CREATE TRIGGER finops_tenant_relationship_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION finops_assert_tenant_consistency()',
      table_name
    );
  END LOOP;
END
$$;

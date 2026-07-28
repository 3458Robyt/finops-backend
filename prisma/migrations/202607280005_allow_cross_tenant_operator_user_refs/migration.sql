-- User references can legitimately cross the user's home tenant when the
-- operator is a MASTER_ADMIN or has an active tenant access assignment.
-- The assignment table itself is the grant that establishes this relation.
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
  parent_role text;
  has_active_assignment boolean;
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
      IF foreign_key.parent_table = 'users' THEN
        EXECUTE format(
          'SELECT role::text FROM %I.%I WHERE %I::text = $1 LIMIT 1',
          foreign_key.parent_schema,
          foreign_key.parent_table,
          foreign_key.parent_column
        )
        INTO parent_role
        USING child_value;

        IF parent_role = 'MASTER_ADMIN' OR TG_TABLE_NAME = 'tenant_access_assignments' THEN
          CONTINUE;
        END IF;

        EXECUTE format(
          'SELECT EXISTS (SELECT 1 FROM %I.tenant_access_assignments WHERE tenant_id::text = $1 AND user_id::text = $2 AND disabled_at IS NULL)',
          foreign_key.parent_schema
        )
        INTO has_active_assignment
        USING NEW.tenant_id::text, child_value;

        IF has_active_assignment THEN
          CONTINUE;
        END IF;
      END IF;

      RAISE EXCEPTION 'Tenant relationship violation on %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION finops_assert_tenant_consistency() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_assert_tenant_consistency() TO finops_runtime;

-- Close tenant-owned tables omitted from the initial runtime isolation migration.
ALTER TABLE cloud_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finops_tenant_isolation ON cloud_connections;
CREATE POLICY finops_tenant_isolation ON cloud_connections
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());

ALTER TABLE operator_storage_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finops_tenant_isolation ON operator_storage_locations;
CREATE POLICY finops_tenant_isolation ON operator_storage_locations
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id())
  WITH CHECK (tenant_id = finops_active_tenant_id());

-- A cloud export is tenant-owned through both its connection and optional
-- storage location. Enforce both links so a tenant cannot attach another
-- tenant's storage destination to an otherwise valid export configuration.
DROP POLICY IF EXISTS finops_parent_tenant_isolation ON cloud_export_configs;
CREATE POLICY finops_parent_tenant_isolation ON cloud_export_configs
  FOR ALL TO finops_runtime
  USING (
    EXISTS (
      SELECT 1
      FROM cloud_connections c
      WHERE c.id = cloud_connection_id
        AND c.tenant_id = finops_active_tenant_id()
    )
    AND (
      storage_location_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM operator_storage_locations s
        WHERE s.id = storage_location_id
          AND s.tenant_id = finops_active_tenant_id()
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM cloud_connections c
      WHERE c.id = cloud_connection_id
        AND c.tenant_id = finops_active_tenant_id()
    )
    AND (
      storage_location_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM operator_storage_locations s
        WHERE s.id = storage_location_id
          AND s.tenant_id = finops_active_tenant_id()
      )
    )
  );

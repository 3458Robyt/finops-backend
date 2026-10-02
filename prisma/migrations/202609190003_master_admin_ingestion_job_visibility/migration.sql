-- Master administrators operate the global ingestion console, while workers
-- keep their explicit cross-tenant queue context. Tenant users remain scoped
-- to the active tenant.

DROP POLICY IF EXISTS finops_tenant_isolation ON ingestion_jobs;
CREATE POLICY finops_tenant_isolation ON ingestion_jobs
  FOR ALL TO finops_runtime
  USING (
    tenant_id = finops_active_tenant_id()
    OR finops_context_value('app.worker_id') IS NOT NULL
    OR finops_current_user_role() = 'MASTER_ADMIN'
  )
  WITH CHECK (
    tenant_id = finops_active_tenant_id()
    OR finops_context_value('app.worker_id') IS NOT NULL
    OR finops_current_user_role() = 'MASTER_ADMIN'
  );

DROP POLICY IF EXISTS finops_tenant_isolation ON cloud_connections;
CREATE POLICY finops_tenant_isolation ON cloud_connections
  FOR ALL TO finops_runtime
  USING (
    tenant_id = finops_active_tenant_id()
    OR finops_context_value('app.worker_id') IS NOT NULL
    OR finops_current_user_role() = 'MASTER_ADMIN'
  )
  WITH CHECK (
    tenant_id = finops_active_tenant_id()
    OR finops_context_value('app.worker_id') IS NOT NULL
    OR finops_current_user_role() = 'MASTER_ADMIN'
  );

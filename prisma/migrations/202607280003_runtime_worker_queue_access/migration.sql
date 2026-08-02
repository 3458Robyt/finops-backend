-- Queue claimers need a controlled cross-tenant view before they know the
-- tenant of the row they are about to process. The application must always
-- switch to the claimed tenant context before reading or writing payload data.

DROP POLICY IF EXISTS finops_tenant_isolation ON ingestion_jobs;
CREATE POLICY finops_tenant_isolation ON ingestion_jobs
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL)
  WITH CHECK (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL);

DROP POLICY IF EXISTS finops_tenant_isolation ON agent_learning_events;
CREATE POLICY finops_tenant_isolation ON agent_learning_events
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL)
  WITH CHECK (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL);

DROP POLICY IF EXISTS finops_tenant_isolation ON recommendation_analysis_runs;
CREATE POLICY finops_tenant_isolation ON recommendation_analysis_runs
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL)
  WITH CHECK (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL);

DROP POLICY IF EXISTS finops_tenant_isolation ON recommendations;
CREATE POLICY finops_tenant_isolation ON recommendations
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL)
  WITH CHECK (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL);

DROP POLICY IF EXISTS finops_tenant_isolation ON cloud_connections;
CREATE POLICY finops_tenant_isolation ON cloud_connections
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL)
  WITH CHECK (tenant_id = finops_active_tenant_id() OR finops_context_value('app.worker_id') IS NOT NULL);

DROP POLICY IF EXISTS finops_parent_tenant_isolation ON cloud_connection_credentials;
CREATE POLICY finops_parent_tenant_isolation ON cloud_connection_credentials
  FOR ALL TO finops_runtime
  USING (
    finops_context_value('app.worker_id') IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM cloud_connections c
      WHERE c.id = cloud_connection_id
        AND c.tenant_id = finops_active_tenant_id()
    )
  )
  WITH CHECK (
    finops_context_value('app.worker_id') IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM cloud_connections c
      WHERE c.id = cloud_connection_id
        AND c.tenant_id = finops_active_tenant_id()
    )
  );

DROP POLICY IF EXISTS finops_parent_tenant_isolation ON cloud_export_configs;
CREATE POLICY finops_parent_tenant_isolation ON cloud_export_configs
  FOR ALL TO finops_runtime
  USING (
    finops_context_value('app.worker_id') IS NOT NULL
    OR (
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
  )
  WITH CHECK (
    finops_context_value('app.worker_id') IS NOT NULL
    OR (
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
  );

DROP POLICY IF EXISTS finops_analysis_link_isolation ON recommendation_analysis_run_recommendations;
CREATE POLICY finops_analysis_link_isolation ON recommendation_analysis_run_recommendations
  FOR ALL TO finops_runtime
  USING (
    finops_context_value('app.worker_id') IS NOT NULL
    OR (
      EXISTS (
        SELECT 1 FROM recommendation_analysis_runs r
        WHERE r.id = run_id AND r.tenant_id = finops_active_tenant_id()
      )
      AND EXISTS (
        SELECT 1 FROM recommendations r
        WHERE r.id = recommendation_id AND r.tenant_id = finops_active_tenant_id()
      )
    )
  )
  WITH CHECK (
    finops_context_value('app.worker_id') IS NOT NULL
    OR (
      EXISTS (
        SELECT 1 FROM recommendation_analysis_runs r
        WHERE r.id = run_id AND r.tenant_id = finops_active_tenant_id()
      )
      AND EXISTS (
        SELECT 1 FROM recommendations r
        WHERE r.id = recommendation_id AND r.tenant_id = finops_active_tenant_id()
      )
    )
  );

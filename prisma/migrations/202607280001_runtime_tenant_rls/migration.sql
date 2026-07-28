-- Runtime isolation for the backend. The migration role remains the owner;
-- the application assumes the non-owner finops_runtime role at query time.
DO $$
BEGIN
  CREATE ROLE finops_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;

GRANT finops_runtime TO postgres;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO finops_runtime', schema_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO finops_runtime', schema_name);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO finops_runtime', schema_name);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM anon, authenticated', schema_name);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM anon, authenticated', schema_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO finops_runtime', schema_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO finops_runtime', schema_name);
END
$$;

CREATE OR REPLACE FUNCTION finops_context_value(setting_name text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting(setting_name, true), '')
$$;

CREATE OR REPLACE FUNCTION finops_active_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT finops_context_value('app.tenant_id')
$$;

CREATE OR REPLACE FUNCTION finops_current_user_id()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT finops_context_value('app.user_id')
$$;

CREATE OR REPLACE FUNCTION finops_current_user_role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT finops_context_value('app.user_role')
$$;

CREATE OR REPLACE FUNCTION finops_login_email()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT finops_context_value('app.login_email')
$$;

REVOKE ALL ON FUNCTION finops_context_value(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_active_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_current_user_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION finops_login_email() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finops_context_value(text) TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_active_tenant_id() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_current_user_id() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_current_user_role() TO finops_runtime;
GRANT EXECUTE ON FUNCTION finops_login_email() TO finops_runtime;

-- Tenant-owned tables use one closed policy for every operation. Master-admin
-- management is intentionally handled only by the access tables below.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'cloud_accounts',
    'ingestion_runs',
    'ingestion_jobs',
    'ingestion_objects',
    'ingestion_watermarks',
    'focus_cost_line_items',
    'cloud_resources',
    'resource_metric_samples',
    'agent_installations',
    'data_quality_checks',
    'cost_metrics',
    'recommendations',
    'in_app_notifications',
    'cost_anomalies',
    'cost_forecasts',
    'budgets',
    'budget_alerts',
    'cost_allocation_rules',
    'recommendation_manual_executions',
    'recommendation_savings_measurements',
    'agent_learning_events',
    'tenant_agent_rules',
    'context_summary_cache',
    'ai_context_traces',
    'context_build_runs',
    'telegram_chat_links',
    'outbound_message_deliveries',
    'recommendation_analysis_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY finops_tenant_isolation ON %I FOR ALL TO finops_runtime USING (tenant_id = finops_active_tenant_id()) WITH CHECK (tenant_id = finops_active_tenant_id())', table_name);
  END LOOP;
END
$$;

-- Nullable tenant_id tables keep global/system records separate from a
-- tenant's records. Global records are readable by the backend only and are
-- writable only by operator roles or an explicit worker context.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['agent_memory', 'agent_instruction_audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY finops_nullable_tenant_isolation ON %I FOR ALL TO finops_runtime USING (tenant_id = finops_active_tenant_id() OR (tenant_id IS NULL AND finops_current_user_role() IN (''MASTER_ADMIN'', ''OPERATOR_ADMIN'', ''FINOPS_TECHNICIAN''))) WITH CHECK (tenant_id = finops_active_tenant_id() OR (tenant_id IS NULL AND finops_current_user_role() IN (''MASTER_ADMIN'', ''OPERATOR_ADMIN'', ''FINOPS_TECHNICIAN'')))', table_name);
  END LOOP;
END
$$;

ALTER TABLE telegram_interaction_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_telegram_interaction_isolation ON telegram_interaction_logs
  FOR ALL TO finops_runtime
  USING (
    tenant_id = finops_active_tenant_id()
    OR (tenant_id IS NULL AND finops_context_value('app.worker_id') = 'telegram-webhook')
  )
  WITH CHECK (
    tenant_id = finops_active_tenant_id()
    OR (tenant_id IS NULL AND finops_context_value('app.worker_id') = 'telegram-webhook')
  );

-- Tables whose tenant is obtained through a protected parent relation.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['cloud_connection_credentials', 'cloud_export_configs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY finops_parent_tenant_isolation ON %I FOR ALL TO finops_runtime USING (EXISTS (SELECT 1 FROM cloud_connections c WHERE c.id = cloud_connection_id AND c.tenant_id = finops_active_tenant_id())) WITH CHECK (EXISTS (SELECT 1 FROM cloud_connections c WHERE c.id = cloud_connection_id AND c.tenant_id = finops_active_tenant_id()))', table_name);
  END LOOP;
END
$$;

ALTER TABLE recommendation_analysis_run_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_analysis_link_isolation ON recommendation_analysis_run_recommendations
  FOR ALL TO finops_runtime
  USING (
    EXISTS (SELECT 1 FROM recommendation_analysis_runs r WHERE r.id = run_id AND r.tenant_id = finops_active_tenant_id())
    AND EXISTS (SELECT 1 FROM recommendations r WHERE r.id = recommendation_id AND r.tenant_id = finops_active_tenant_id())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM recommendation_analysis_runs r WHERE r.id = run_id AND r.tenant_id = finops_active_tenant_id())
    AND EXISTS (SELECT 1 FROM recommendations r WHERE r.id = recommendation_id AND r.tenant_id = finops_active_tenant_id())
  );

ALTER TABLE recommendation_execution_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_execution_plan_isolation ON recommendation_execution_plans
  FOR ALL TO finops_runtime
  USING (EXISTS (SELECT 1 FROM recommendations r WHERE r.id = recommendation_id AND r.tenant_id = finops_active_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM recommendations r WHERE r.id = recommendation_id AND r.tenant_id = finops_active_tenant_id()));

ALTER TABLE recommendation_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_decision_isolation ON recommendation_decisions
  FOR ALL TO finops_runtime
  USING (
    EXISTS (SELECT 1 FROM recommendations r WHERE r.id = recommendation_id AND r.tenant_id = finops_active_tenant_id())
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND (u.tenant_id = finops_active_tenant_id() OR u.id = finops_current_user_id()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM recommendations r WHERE r.id = recommendation_id AND r.tenant_id = finops_active_tenant_id())
    AND user_id = finops_current_user_id()
  );

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_session_isolation ON auth_sessions
  FOR ALL TO finops_runtime
  USING (
    user_id = finops_current_user_id()
    OR finops_current_user_role() = 'MASTER_ADMIN'
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.email = finops_login_email())
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR finops_current_user_role() = 'MASTER_ADMIN'
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.email = finops_login_email())
  );

-- Bootstrap and authorization tables have explicit policies because login,
-- tenant selection and master-admin management are not normal tenant reads.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_tenant_directory ON tenants
  FOR SELECT TO finops_runtime
  USING (
    finops_current_user_role() = 'MASTER_ADMIN'
    OR id = finops_active_tenant_id()
    OR EXISTS (
      SELECT 1 FROM tenant_access_assignments a
      WHERE a.tenant_id = tenants.id AND a.user_id = finops_current_user_id() AND a.disabled_at IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM users u
      WHERE u.email = finops_login_email()
        AND (u.tenant_id = tenants.id OR u.role = 'MASTER_ADMIN'
          OR EXISTS (SELECT 1 FROM tenant_access_assignments a WHERE a.tenant_id = tenants.id AND a.user_id = u.id AND a.disabled_at IS NULL))
    )
  );
CREATE POLICY finops_tenant_management ON tenants
  FOR INSERT TO finops_runtime
  WITH CHECK (finops_current_user_role() = 'MASTER_ADMIN');
CREATE POLICY finops_tenant_update ON tenants
  FOR UPDATE TO finops_runtime
  USING (finops_current_user_role() = 'MASTER_ADMIN')
  WITH CHECK (finops_current_user_role() = 'MASTER_ADMIN');
CREATE POLICY finops_tenant_delete ON tenants
  FOR DELETE TO finops_runtime
  USING (finops_current_user_role() = 'MASTER_ADMIN');

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_user_directory ON users
  FOR SELECT TO finops_runtime
  USING (
    finops_current_user_role() = 'MASTER_ADMIN'
    OR id = finops_current_user_id()
    OR tenant_id = finops_active_tenant_id()
    OR email = finops_login_email()
  );
CREATE POLICY finops_user_management ON users
  FOR INSERT TO finops_runtime
  WITH CHECK (finops_current_user_role() = 'MASTER_ADMIN');
CREATE POLICY finops_user_update ON users
  FOR UPDATE TO finops_runtime
  USING (finops_current_user_role() = 'MASTER_ADMIN' OR id = finops_current_user_id() OR email = finops_login_email())
  WITH CHECK (finops_current_user_role() = 'MASTER_ADMIN' OR id = finops_current_user_id() OR email = finops_login_email());
CREATE POLICY finops_user_delete ON users
  FOR DELETE TO finops_runtime
  USING (finops_current_user_role() = 'MASTER_ADMIN');

ALTER TABLE tenant_access_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_assignment_directory ON tenant_access_assignments
  FOR SELECT TO finops_runtime
  USING (
    finops_current_user_role() = 'MASTER_ADMIN'
    OR user_id = finops_current_user_id()
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.email = finops_login_email())
  );
CREATE POLICY finops_assignment_management ON tenant_access_assignments
  FOR INSERT TO finops_runtime
  WITH CHECK (finops_current_user_role() = 'MASTER_ADMIN');
CREATE POLICY finops_assignment_update ON tenant_access_assignments
  FOR UPDATE TO finops_runtime
  USING (finops_current_user_role() = 'MASTER_ADMIN')
  WITH CHECK (finops_current_user_role() = 'MASTER_ADMIN');
CREATE POLICY finops_assignment_delete ON tenant_access_assignments
  FOR DELETE TO finops_runtime
  USING (finops_current_user_role() = 'MASTER_ADMIN');

ALTER TABLE operator_organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_operator_directory ON operator_organizations
  FOR SELECT TO finops_runtime
  USING (true);

ALTER TABLE provider_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_provider_catalog_read ON provider_catalog
  FOR SELECT TO finops_runtime
  USING (true);

ALTER TABLE agent_instruction_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_instruction_profile_access ON agent_instruction_profiles
  FOR ALL TO finops_runtime
  USING (finops_current_user_role() IN ('MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN', 'ADMIN'))
  WITH CHECK (finops_current_user_role() IN ('MASTER_ADMIN', 'OPERATOR_ADMIN', 'FINOPS_TECHNICIAN', 'ADMIN'));

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY finops_audit_isolation ON audit_events
  FOR ALL TO finops_runtime
  USING (tenant_id = finops_active_tenant_id() OR finops_current_user_role() = 'MASTER_ADMIN')
  WITH CHECK (tenant_id = finops_active_tenant_id() OR finops_current_user_role() = 'MASTER_ADMIN');

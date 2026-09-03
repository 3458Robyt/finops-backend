-- Message workers need to read recipient preferences while generating and
-- draining tenant-scoped notifications. They remain the only non-user
-- principals allowed to access this table through the runtime role.
DROP POLICY IF EXISTS "finops_messaging_preferences_isolation" ON "user_messaging_preferences";
CREATE POLICY "finops_messaging_preferences_isolation" ON "user_messaging_preferences"
  FOR ALL TO finops_runtime
  USING (
    "user_id" = (SELECT finops_current_user_id())
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'message-%'
  )
  WITH CHECK (
    "user_id" = (SELECT finops_current_user_id())
    OR (SELECT finops_context_value('app.worker_id')) LIKE 'message-%'
  );

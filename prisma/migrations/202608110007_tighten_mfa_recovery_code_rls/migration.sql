DROP POLICY IF EXISTS finops_mfa_recovery_code_isolation ON "mfa_recovery_codes";

CREATE POLICY finops_mfa_recovery_code_isolation ON "mfa_recovery_codes"
  FOR ALL TO finops_runtime
  USING (
    user_id = finops_current_user_id()
    OR user_id = finops_mfa_challenge_user_id()
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR user_id = finops_mfa_challenge_user_id()
  );

ALTER POLICY finops_session_isolation ON auth_sessions
  USING (
    user_id = finops_current_user_id()
    OR finops_current_user_role() = 'MASTER_ADMIN'
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.email = finops_login_email())
    OR EXISTS (
      SELECT 1 FROM auth_refresh_tokens r
      WHERE r.session_id = auth_sessions.id
        AND r.token_hash = finops_refresh_token_hash()
    )
    OR EXISTS (
      SELECT 1 FROM password_reset_tokens p
      WHERE p.user_id = auth_sessions.user_id
        AND p.token_hash = finops_password_reset_token_hash()
    )
  )
  WITH CHECK (
    user_id = finops_current_user_id()
    OR finops_current_user_role() = 'MASTER_ADMIN'
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.email = finops_login_email())
    OR EXISTS (
      SELECT 1 FROM auth_refresh_tokens r
      WHERE r.session_id = auth_sessions.id
        AND r.token_hash = finops_refresh_token_hash()
    )
    OR EXISTS (
      SELECT 1 FROM password_reset_tokens p
      WHERE p.user_id = auth_sessions.user_id
        AND p.token_hash = finops_password_reset_token_hash()
    )
  );

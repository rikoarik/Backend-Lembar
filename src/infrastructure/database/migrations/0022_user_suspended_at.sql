-- Migration 0022: per-user suspend state
-- Ponytail: was previously only flipping admin_billing.state for the
-- workspace, which silently leaked (a) no per-user revocation and (b) no
-- JWT invalidation because the auth service never consulted billing.
-- Add suspended_at column so login + middleware can reject the user.
--
-- Rollback:
--   DROP INDEX IF EXISTS jwt_users_suspended_at_idx;
--   ALTER TABLE jwt_users DROP COLUMN IF EXISTS suspended_reason;
--   ALTER TABLE jwt_users DROP COLUMN IF EXISTS suspended_at;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'jwt_users' AND column_name = 'suspended_at'
  ) THEN
    ALTER TABLE jwt_users ADD COLUMN suspended_at timestamptz;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'jwt_users' AND column_name = 'suspended_reason'
  ) THEN
    ALTER TABLE jwt_users ADD COLUMN suspended_reason text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS jwt_users_suspended_at_idx
  ON jwt_users (suspended_at)
  WHERE suspended_at IS NOT NULL;

-- Migration: 0021_password_reset_and_invites
-- Ponytail: dedicated table for password reset tokens; nullable password_hash +
-- needs_password_setup flag for invited users who have not finished onboarding.
-- Rollback:
--   DROP TABLE IF EXISTS password_resets;
--   ALTER TABLE jwt_users DROP COLUMN IF EXISTS needs_password_setup;
--   ALTER TABLE jwt_users ALTER COLUMN password_hash SET NOT NULL;

CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES jwt_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS password_resets_expires_idx ON password_resets(expires_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'jwt_users' AND column_name = 'needs_password_setup'
  ) THEN
    ALTER TABLE jwt_users ADD COLUMN needs_password_setup boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- Existing users must still satisfy the password_hash constraint until invites land.
-- Drop NOT NULL only if still enforced by the column definition.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'jwt_users' AND column_name = 'password_hash' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE jwt_users ALTER COLUMN password_hash DROP NOT NULL;
  END IF;
END $$;

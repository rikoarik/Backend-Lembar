-- Migration: 0015_jwt_users_username_phone
-- Adds username + phone for full register form parity with FE auth UI.
-- Rollback:
--   ALTER TABLE jwt_users DROP CONSTRAINT IF EXISTS jwt_users_username_unique;
--   ALTER TABLE jwt_users DROP CONSTRAINT IF EXISTS jwt_users_phone_unique;
--   ALTER TABLE jwt_users DROP COLUMN IF EXISTS username;
--   ALTER TABLE jwt_users DROP COLUMN IF EXISTS phone;

ALTER TABLE "jwt_users"
  ADD COLUMN IF NOT EXISTS "username" text,
  ADD COLUMN IF NOT EXISTS "phone" text;

-- Backfill username for existing rows from email local-part when empty
UPDATE "jwt_users"
SET "username" = split_part("email", '@', 1)
WHERE "username" IS NULL OR btrim("username") = '';

-- Ensure uniqueness after backfill (append short id on collisions)
WITH ranked AS (
  SELECT
    id,
    username,
    ROW_NUMBER() OVER (PARTITION BY lower(username) ORDER BY created_at, id) AS rn
  FROM jwt_users
  WHERE username IS NOT NULL
)
UPDATE jwt_users u
SET username = u.username || '_' || substr(replace(u.id::text, '-', ''), 1, 6)
FROM ranked r
WHERE u.id = r.id
  AND r.rn > 1;

ALTER TABLE "jwt_users"
  ALTER COLUMN "username" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jwt_users_username_unique'
  ) THEN
    ALTER TABLE "jwt_users"
      ADD CONSTRAINT "jwt_users_username_unique" UNIQUE ("username");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'jwt_users_phone_unique'
  ) THEN
    ALTER TABLE "jwt_users"
      ADD CONSTRAINT "jwt_users_phone_unique" UNIQUE ("phone");
  END IF;
END $$;

BEGIN;
SELECT pg_advisory_xact_lock(240025);

CREATE TABLE IF NOT EXISTS generation_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES jwt_users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 100),
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS generation_templates_workspace_idx
  ON generation_templates (workspace_id, updated_at DESC);

COMMIT;

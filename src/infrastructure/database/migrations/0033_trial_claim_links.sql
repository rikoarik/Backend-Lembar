BEGIN;
SELECT pg_advisory_xact_lock(260033);

CREATE TABLE IF NOT EXISTS trial_claim_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES jwt_users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trial_claim_links_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT trial_claim_links_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT trial_claim_links_used_at_check CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS trial_claim_links_token_unique
  ON trial_claim_links(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS trial_claim_links_user_unique
  ON trial_claim_links(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS trial_claim_links_workspace_unique
  ON trial_claim_links(workspace_id);
CREATE INDEX IF NOT EXISTS trial_claim_links_expiry_idx
  ON trial_claim_links(expires_at) WHERE used_at IS NULL;

COMMIT;

-- Tokens are temporary capabilities. Rollback: DROP TABLE trial_claim_links;

BEGIN;
SELECT pg_advisory_xact_lock(260026);

CREATE TABLE IF NOT EXISTS trial_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES jwt_users(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email_hash text NOT NULL,
  phone_hash text NOT NULL,
  device_hash text NOT NULL,
  ip_hash text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trial_claims_duration_check CHECK (ends_at = starts_at + interval '60 days'),
  CONSTRAINT trial_claims_email_hash_check CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT trial_claims_phone_hash_check CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT trial_claims_device_hash_check CHECK (device_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT trial_claims_ip_hash_check CHECK (ip_hash ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS trial_claims_user_unique ON trial_claims(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS trial_claims_email_hash_unique ON trial_claims(email_hash);
CREATE UNIQUE INDEX IF NOT EXISTS trial_claims_phone_hash_unique ON trial_claims(phone_hash);
CREATE UNIQUE INDEX IF NOT EXISTS trial_claims_workspace_unique ON trial_claims(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS trial_claims_device_unique ON trial_claims(device_hash);

CREATE TABLE IF NOT EXISTS plan_generation_usage (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, idempotency_key)
);

COMMIT;

-- Forward fix/rollback before claims exist: DROP TABLE trial_claims;
-- After claims exist, preserve this immutable abuse ledger; do not drop it on feature disable.

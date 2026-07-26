-- B8-02: Data lifecycle, retention, deletion, tombstone gate
-- Soft-delete columns for jwt_users and assessments
-- Delete schedule queue for deferred hard-delete
-- Tombstone table for audit trail after hard-delete

-- ── 1. Soft-delete column on jwt_users ────────────────────────────────────────
ALTER TABLE jwt_users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS jwt_users_deleted_at_idx
  ON jwt_users (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ── 2. Soft-delete column on assessments (if table exists) ────────────────────
-- assessments are stored in-memory in v1, but we guard with IF EXISTS
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'assessments'
  ) THEN
    EXECUTE 'ALTER TABLE assessments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL';
  END IF;
END $$;

-- ── 3. Delete schedule queue ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_delete_schedule (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL,
  scheduled_by    UUID        NOT NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  purge_after     TIMESTAMPTZ NOT NULL,
  retention_days  INTEGER     NOT NULL DEFAULT 30,
  reason          TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'executed', 'cancelled')),
  executed_at     TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_delete_schedule_account_id_idx
  ON account_delete_schedule (account_id);

CREATE INDEX IF NOT EXISTS account_delete_schedule_purge_after_idx
  ON account_delete_schedule (purge_after)
  WHERE status = 'pending';

-- ── 4. Tombstone table (immutable audit trail after hard-delete) ───────────────
CREATE TABLE IF NOT EXISTS account_tombstones (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  original_id     UUID        NOT NULL UNIQUE,
  email_hash      TEXT        NOT NULL,
  roles           TEXT[]      NOT NULL DEFAULT '{}',
  tenant_id       UUID,
  workspace_id    UUID,
  deleted_by      UUID        NOT NULL,
  delete_reason   TEXT,
  snapshot        JSONB       NOT NULL DEFAULT '{}',
  retention_days  INTEGER     NOT NULL DEFAULT 30,
  purged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_tombstones_original_id_idx
  ON account_tombstones (original_id);

CREATE INDEX IF NOT EXISTS account_tombstones_purged_at_idx
  ON account_tombstones (purged_at);

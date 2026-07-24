-- Migration: 0016_admin_ops_tables
-- Superadmin ops: flags, prompts, quality_reports, admin_audit, school billing data
-- Rollback:
--   DROP TABLE IF EXISTS admin_audit;
--   DROP TABLE IF EXISTS admin_flags;
--   DROP TABLE IF EXISTS admin_prompts;
--   DROP TABLE IF EXISTS admin_quality_reports;

-- ── Feature flags ──────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'pilot')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Prompt library ─────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  prompt_text text NOT NULL DEFAULT '',
  version text NOT NULL DEFAULT 'v1',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('active', 'draft')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Quality reports ────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_quality_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  assessment_version_id text NOT NULL DEFAULT '',
  reporter text NOT NULL DEFAULT '',
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'closed')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Admin audit trail ──────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL,
  actor_email text NOT NULL DEFAULT '',
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit(actor_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit(action);

-- ── School billing mock data ───────────────────────
CREATE TABLE IF NOT EXISTS admin_billing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  school_name text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'grace', 'blocked', 'expired')),
  seats integer NOT NULL DEFAULT 0,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pilot', 'pro')),
  renews_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Dashboard KPI (derived from data, no table needed) ──
-- KPI is computed on-the-fly from jwt_users, tenants, spike_jobs, admin_quality_reports

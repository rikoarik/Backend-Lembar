-- Monthly provider-token accounting. Apply manually after verification.
ALTER TABLE ai_jobs_audit DROP CONSTRAINT IF EXISTS ai_jobs_audit_driver_check;
ALTER TABLE ai_jobs_audit ADD CONSTRAINT ai_jobs_audit_driver_check
  CHECK (driver IN ('mock','openai','hermes'));
ALTER TABLE ai_jobs_audit ADD COLUMN IF NOT EXISTS prompt_tokens_actual integer;
ALTER TABLE ai_jobs_audit ADD COLUMN IF NOT EXISTS completion_tokens_actual integer;

ALTER TABLE workspace_plans
  ADD COLUMN IF NOT EXISTS tokens_used_this_month bigint NOT NULL DEFAULT 0;
ALTER TABLE workspace_plans ADD COLUMN IF NOT EXISTS token_monthly_limit bigint;

CREATE TABLE IF NOT EXISTS ai_token_usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  provider_call_id text NOT NULL,
  tokens bigint NOT NULL CHECK (tokens >= 0),
  usage_source text NOT NULL CHECK (usage_source IN ('actual','estimated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workspace_id, provider_call_id)
);
CREATE INDEX IF NOT EXISTS ai_token_usage_ledger_workspace_idx
  ON ai_token_usage_ledger(tenant_id, workspace_id, created_at);
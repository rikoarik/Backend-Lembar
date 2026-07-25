-- Migration: 0017_ai_prompt_management
-- Upgrade admin_prompts → full AI prompt management system
-- Rollback:
--   DROP TABLE IF EXISTS ai_prompt_versions;
--   DROP TABLE IF EXISTS ai_prompt_eval_cases;
--   DROP TABLE IF EXISTS ai_prompt_schemas;
--   ALTER TABLE admin_prompts DROP COLUMN IF EXISTS schema_id;
--   ALTER TABLE admin_prompts DROP COLUMN IF EXISTS description_long;
--   ALTER TABLE admin_prompts DROP COLUMN IF EXISTS active_version;

-- ── Prompt schemas (JSON schema per type) ──────────
CREATE TABLE IF NOT EXISTS ai_prompt_schemas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  schema_type text NOT NULL CHECK (schema_type IN ('assessment', 'repair', 'quality_check', 'review', 'custom')),
  json_schema jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Upgrade admin_prompts ─────────────────────────
ALTER TABLE admin_prompts ADD COLUMN IF NOT EXISTS description_long text DEFAULT '';
ALTER TABLE admin_prompts ADD COLUMN IF NOT EXISTS active_version integer DEFAULT 1;
ALTER TABLE admin_prompts ADD COLUMN IF NOT EXISTS schema_id uuid REFERENCES ai_prompt_schemas(id) ON DELETE SET NULL;
ALTER TABLE admin_prompts ADD COLUMN IF NOT EXISTS context_window text DEFAULT 'default';
ALTER TABLE admin_prompts ADD COLUMN IF NOT EXISTS avg_latency_ms integer DEFAULT 0;
ALTER TABLE admin_prompts ADD COLUMN IF NOT EXISTS avg_cost_usd numeric(10,4) DEFAULT 0;
ALTER TABLE admin_prompts ADD COLUMN IF NOT EXISTS success_rate numeric(5,2) DEFAULT 0;
ALTER TABLE admin_prompts ADD COLUMN IF NOT EXISTS total_runs integer DEFAULT 0;
ALTER TABLE admin_prompts ADD COLUMN IF NOT EXISTS last_run_at timestamptz;

-- ── Prompt versions (versioned prompt text) ────────
CREATE TABLE IF NOT EXISTS ai_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id uuid NOT NULL REFERENCES admin_prompts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  prompt_text text NOT NULL DEFAULT '',
  schema_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('active', 'draft', 'archived')),
  created_by text,
  notes text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version)
);

-- ── Eval cases per prompt version ──────────────────
CREATE TABLE IF NOT EXISTS ai_prompt_eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id uuid NOT NULL REFERENCES admin_prompts(id) ON DELETE CASCADE,
  prompt_version integer NOT NULL,
  label text NOT NULL,
  input_signals jsonb NOT NULL DEFAULT '{}',
  expected_output jsonb,
  validate_rules jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Seed common schemas ────────────────────────────
INSERT INTO ai_prompt_schemas (name, schema_type, json_schema) VALUES
  ('Assessment v1', 'assessment', '{
    "type": "object",
    "required": ["title", "questions"],
    "properties": {
      "title": {"type": "string"},
      "questions": {"type": "array", "items": {"type": "object", "required": ["question", "options", "answer"], "properties": {"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}}, "answer": {"type": "string"}, "explanation": {"type": "string"}}}}
    }
  }'),
  ('Repair v1', 'repair', '{
    "type": "object",
    "required": ["fixed_payload", "issues_found"],
    "properties": {
      "fixed_payload": {"type": "object"},
      "issues_found": {"type": "array", "items": {"type": "object", "required": ["field", "severity", "description"]}},
      "summary": {"type": "string"}
    }
  }'),
  ('Quality Check v1', 'quality_check', '{
    "type": "object",
    "required": ["valid", "score", "issues"],
    "properties": {
      "valid": {"type": "boolean"},
      "score": {"type": "number", "minimum": 0, "maximum": 100},
      "issues": {"type": "array", "items": {"type": "object", "required": ["severity", "message"]}},
      "recommendations": {"type": "array", "items": {"type": "string"}}
    }
  }')
ON CONFLICT DO NOTHING;

-- ── Seed default prompts with versions ─────────────
DO $$
DECLARE
  gen_id uuid;
  repair_id uuid;
  quality_id uuid;
BEGIN
  -- Generate prompt
  INSERT INTO admin_prompts (name, slug, description, description_long, status, version, created_by, context_window)
  VALUES ('generate.v3', 'generate-v3', 'Main assessment generation prompt', 'Membuat soal ujian dari materi dan kurikulum', 'active', 3, 'ops@lembar.id', 'default')
  ON CONFLICT (slug) DO UPDATE SET description_long = EXCLUDED.description_long, context_window = EXCLUDED.context_window
  RETURNING id INTO gen_id;

  -- Repair prompt
  INSERT INTO admin_prompts (name, slug, description, description_long, status, version, created_by, context_window)
  VALUES ('repair.schema', 'repair-schema', 'Schema repair for generated outputs', 'Memperbaiki output AI yang tidak sesuai schema', 'active', 2, 'ops@lembar.id', 'default')
  ON CONFLICT (slug) DO UPDATE SET description_long = EXCLUDED.description_long
  RETURNING id INTO repair_id;

  -- Quality prompt
  INSERT INTO admin_prompts (name, slug, description, description_long, status, version, created_by, context_window)
  VALUES ('quality.guard', 'quality-guard', 'Quality guard for output validation', 'Validasi kualitas output sebelum disimpan', 'draft', 1, 'ops@lembar.id', 'default')
  ON CONFLICT (slug) DO UPDATE SET description_long = EXCLUDED.description_long
  RETURNING id INTO quality_id;

  -- Seed versions
  IF gen_id IS NOT NULL THEN
    INSERT INTO ai_prompt_versions (prompt_id, version, prompt_text, schema_version, status, notes)
    VALUES (gen_id, 3, 'You are an expert Indonesian curriculum assessment designer. Create a comprehensive assessment following Kurikulum Merdeka standards...', 1, 'active', 'Stable production version')
    ON CONFLICT DO NOTHING;
    INSERT INTO ai_prompt_versions (prompt_id, version, prompt_text, schema_version, status, notes)
    VALUES (gen_id, 2, 'Create an assessment based on the following material...', 1, 'archived', 'Previous version')
    ON CONFLICT DO NOTHING;
  END IF;

  IF repair_id IS NOT NULL THEN
    INSERT INTO ai_prompt_versions (prompt_id, version, prompt_text, schema_version, status, notes)
    VALUES (repair_id, 2, 'Analyze the following JSON and repair schema violations...', 1, 'active', 'Enhanced repair with explanations')
    ON CONFLICT DO NOTHING;
  END IF;

  IF quality_id IS NOT NULL THEN
    INSERT INTO ai_prompt_versions (prompt_id, version, prompt_text, schema_version, status, notes)
    VALUES (quality_id, 1, 'Evaluate this assessment for quality, accuracy, and completeness...', 1, 'draft', 'Initial quality check')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

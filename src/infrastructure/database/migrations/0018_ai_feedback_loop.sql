-- Migration: 0018_ai_feedback_loop
-- Feedback + continuous learning tables
-- Rollback: DROP TABLE IF EXISTS ai_feedback;

CREATE TABLE IF NOT EXISTS ai_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  prompt_template_id text NOT NULL,
  job_id uuid,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment text,
  tags jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_prompt ON ai_feedback(prompt_template_id);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_rating ON ai_feedback(rating);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_created ON ai_feedback(created_at DESC);

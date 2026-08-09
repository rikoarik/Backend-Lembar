-- 0028 assessment attempts. Forward-fix rollback: drop answers then attempts only before production writes.
CREATE TABLE IF NOT EXISTS assessment_attempts (
 id uuid PRIMARY KEY, share_link_id uuid NOT NULL REFERENCES share_links(id) ON DELETE RESTRICT, workspace_id text NOT NULL,
 assessment_id text NOT NULL, guest_name text NOT NULL CHECK (length(trim(guest_name)) BETWEEN 1 AND 120),
 guest_class text CHECK (guest_class IS NULL OR length(guest_class) <= 80),
 status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
 started_at timestamptz NOT NULL DEFAULT now(), last_saved_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz,
 raw_score integer, max_score integer, needs_grading boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS assessment_attempt_answers (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
 question_id uuid NOT NULL REFERENCES generated_questions(id) ON DELETE RESTRICT, value text NOT NULL, is_correct boolean, score integer, needs_grading boolean NOT NULL DEFAULT false,
 graded_at timestamptz, UNIQUE (attempt_id, question_id)
);
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'assessment_attempts'::regclass
    AND conname = 'assessment_attempts_share_link_id_fkey'
    AND confdeltype <> 'r'
 ) THEN
  ALTER TABLE assessment_attempts DROP CONSTRAINT assessment_attempts_share_link_id_fkey;
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'assessment_attempts'::regclass
    AND conname = 'assessment_attempts_share_link_id_fkey'
 ) THEN
  ALTER TABLE assessment_attempts
   ADD CONSTRAINT assessment_attempts_share_link_id_fkey
   FOREIGN KEY (share_link_id) REFERENCES share_links(id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'assessment_attempt_answers'::regclass
    AND conname = 'assessment_attempt_answers_question_id_fkey'
 ) THEN
  ALTER TABLE assessment_attempt_answers
   ADD CONSTRAINT assessment_attempt_answers_question_id_fkey
   FOREIGN KEY (question_id) REFERENCES generated_questions(id) ON DELETE RESTRICT;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS assessment_attempts_results ON assessment_attempts(workspace_id, assessment_id, submitted_at);
CREATE INDEX IF NOT EXISTS assessment_attempt_answers_attempt ON assessment_attempt_answers(attempt_id);

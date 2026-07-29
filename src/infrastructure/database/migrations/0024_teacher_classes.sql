BEGIN;
SELECT pg_advisory_xact_lock(240024);

CREATE TABLE IF NOT EXISTS teacher_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES jwt_users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  grade_label text NOT NULL DEFAULT '' CHECK (char_length(grade_label) <= 80),
  school_year text NOT NULL DEFAULT '' CHECK (char_length(school_year) <= 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS teacher_classes_workspace_idx
  ON teacher_classes (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS class_students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid NOT NULL REFERENCES teacher_classes(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  student_number text NOT NULL DEFAULT '' CHECK (char_length(student_number) <= 50),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS class_students_class_idx
  ON class_students (class_id, name);

COMMIT;

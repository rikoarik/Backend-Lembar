CREATE TABLE IF NOT EXISTS admin_catalog_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_id text NOT NULL,
  subject_id text NOT NULL,
  label text NOT NULL CHECK (char_length(trim(label)) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_catalog_materials_scope_label_unique
  ON admin_catalog_materials (grade_id, subject_id, lower(label));

CREATE INDEX IF NOT EXISTS admin_catalog_materials_scope_idx
  ON admin_catalog_materials (grade_id, subject_id, status);

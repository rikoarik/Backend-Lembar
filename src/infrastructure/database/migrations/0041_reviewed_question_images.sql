-- Generated questions already support optional image metadata; review copies must match.
ALTER TABLE reviewed_questions ADD COLUMN IF NOT EXISTS image jsonb;

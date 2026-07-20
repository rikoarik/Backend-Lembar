ALTER TABLE "marketing_content"
  ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "state" text DEFAULT 'draft' NOT NULL,
  ADD COLUMN IF NOT EXISTS "updated_by" uuid;
ALTER TABLE "marketing_content_versions"
  ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "created_by" uuid;

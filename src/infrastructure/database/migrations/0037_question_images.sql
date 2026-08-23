-- Optional AI-generated visual aids for generated and reviewed questions.
-- Forward-only rollback: drop the constraints first, then drop both image columns.

ALTER TABLE "generated_questions"
  ADD COLUMN IF NOT EXISTS "image" jsonb;
--> statement-breakpoint

ALTER TABLE "generated_questions"
  ADD CONSTRAINT "generated_questions_image_object_check"
    CHECK ("image" IS NULL OR jsonb_typeof("image") = 'object'),
  ADD CONSTRAINT "generated_questions_image_size_check"
    CHECK ("image" IS NULL OR pg_column_size("image") <= 4194304);
--> statement-breakpoint

ALTER TABLE "reviewed_questions"
  ADD COLUMN IF NOT EXISTS "image" jsonb;
--> statement-breakpoint

ALTER TABLE "reviewed_questions"
  ADD CONSTRAINT "reviewed_questions_image_object_check"
    CHECK ("image" IS NULL OR jsonb_typeof("image") = 'object'),
  ADD CONSTRAINT "reviewed_questions_image_size_check"
    CHECK ("image" IS NULL OR pg_column_size("image") <= 4194304);

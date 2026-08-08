CREATE TABLE "generated_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"assessment_version_id" text NOT NULL,
	"blueprint_sequence" integer NOT NULL,
	"question_type" text NOT NULL,
	"difficulty" text NOT NULL,
	"stem" text NOT NULL,
	"options" jsonb NOT NULL,
	"answer" text NOT NULL,
	"explanation" text NOT NULL,
	"source_ids" jsonb NOT NULL,
	"version_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "generated_questions_workspace_version_idx"
  ON "generated_questions" USING btree ("workspace_id", "assessment_version_id", "blueprint_sequence");
--> statement-breakpoint
CREATE INDEX "generated_questions_workspace_idx"
  ON "generated_questions" USING btree ("workspace_id");
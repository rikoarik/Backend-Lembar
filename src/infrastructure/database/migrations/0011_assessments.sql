-- B2-03 — Assessment configuration and draft.
--
-- Three additive tables:
--   assessments          — one row per assessment aggregate (workspace-scoped).
--   assessment_versions  — immutable input snapshot per generation run.
--   blueprint_items      — per-item config: outcome, difficulty, question type, etc.
--
-- Design constraints:
--   - Tenant isolation: every read must include workspace_id.
--   - assessment_versions.config_snapshot is JSONB — immutable after insert.
--   - status enum: draft | generating | ready | failed | archived.
--   - No FK back to cross-module catalog tables; catalog version IDs are stored
--     as opaque references in config_snapshot (same convention as curriculum module).

CREATE TABLE "assessments" (
  "id"                   uuid    PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"         uuid    NOT NULL,
  "creator_user_id"      uuid    NOT NULL,
  "title"                text    NOT NULL,
  "status"               text    NOT NULL DEFAULT 'draft',
  "current_version"      integer NOT NULL DEFAULT 0,
  "idempotency_key"      text,
  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"           timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "assessments_status_check"
    CHECK (status IN ('draft','generating','ready','failed','archived'))
);
--> statement-breakpoint

CREATE INDEX "assessments_workspace_idx"
  ON "assessments" ("workspace_id");
--> statement-breakpoint

CREATE INDEX "assessments_workspace_status_idx"
  ON "assessments" ("workspace_id", "status");
--> statement-breakpoint

CREATE UNIQUE INDEX "assessments_workspace_idempotency_unique"
  ON "assessments" ("workspace_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "assessment_versions" (
  "id"                   uuid    PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assessment_id"        uuid    NOT NULL,
  "workspace_id"         uuid    NOT NULL,
  "version"              integer NOT NULL,
  "status"               text    NOT NULL DEFAULT 'draft',
  -- Immutable snapshot of catalog + source references at submission time.
  "config_snapshot"      jsonb   NOT NULL,
  -- Schema version for forward-compat.
  "schema_version"       text    NOT NULL DEFAULT '1',
  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "assessment_versions_status_check"
    CHECK (status IN ('draft','generating','ready','failed')),
  CONSTRAINT "assessment_versions_version_check"
    CHECK (version >= 1)
);
--> statement-breakpoint

CREATE UNIQUE INDEX "assessment_versions_assessment_version_unique"
  ON "assessment_versions" ("assessment_id", "version");
--> statement-breakpoint

CREATE INDEX "assessment_versions_workspace_idx"
  ON "assessment_versions" ("workspace_id");
--> statement-breakpoint

ALTER TABLE "assessment_versions"
  ADD CONSTRAINT "assessment_versions_assessment_id_fk"
  FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE TABLE "blueprint_items" (
  "id"                   uuid    PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assessment_version_id" uuid   NOT NULL,
  "workspace_id"         uuid    NOT NULL,
  "sequence"             integer NOT NULL,
  -- Catalog references (opaque IDs from curriculum module).
  "curriculum_version_id" text,
  "outcome_id"           text,
  "subject_id"           text,
  "grade_id"             text,
  -- Generation config.
  "question_type"        text    NOT NULL DEFAULT 'multiple_choice',
  "difficulty"           text    NOT NULL DEFAULT 'medium',
  "cognitive_level"      text,
  "topic_hint"           text,
  "source_upload_id"     uuid,
  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "blueprint_items_sequence_check"  CHECK (sequence >= 0),
  CONSTRAINT "blueprint_items_difficulty_check"
    CHECK (difficulty IN ('easy','medium','hard')),
  CONSTRAINT "blueprint_items_question_type_check"
    CHECK (question_type IN ('multiple_choice','short_answer','essay','true_false'))
);
--> statement-breakpoint

CREATE INDEX "blueprint_items_version_idx"
  ON "blueprint_items" ("assessment_version_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "blueprint_items_version_seq_unique"
  ON "blueprint_items" ("assessment_version_id", "sequence");
--> statement-breakpoint

ALTER TABLE "blueprint_items"
  ADD CONSTRAINT "blueprint_items_version_id_fk"
  FOREIGN KEY ("assessment_version_id") REFERENCES "assessment_versions"("id") ON DELETE CASCADE;

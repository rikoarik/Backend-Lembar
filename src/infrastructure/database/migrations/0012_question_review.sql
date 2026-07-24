-- B4-01 — Question review, edit, and audit.
--
-- Tables:
--   reviewed_questions   — versioned, editable view of a GeneratedQuestion.
--   question_audit_log   — immutable append-only audit trail.
--
-- Design constraints:
--   - Tenant isolation: every read must include workspace_id.
--   - version increments on every edit (optimistic concurrency via etag in B4-03).
--   - status: pending | accepted | rejected.
--   - source_ids is JSONB array — never modified by edits (integrity invariant).
--   - audit_log rows are insert-only; no UPDATE/DELETE ever touches them.

CREATE TABLE "reviewed_questions" (
  "id"                     uuid    PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "original_question_id"   uuid    NOT NULL,
  "assessment_version_id"  uuid    NOT NULL,
  "workspace_id"           uuid    NOT NULL,
  "blueprint_sequence"     integer NOT NULL,
  "question_type"          text    NOT NULL,
  "difficulty"             text    NOT NULL,
  "stem"                   text    NOT NULL,
  "options"                jsonb   NOT NULL DEFAULT '[]',
  "answer"                 text    NOT NULL,
  "explanation"            text    NOT NULL DEFAULT '',
  "source_ids"             jsonb   NOT NULL DEFAULT '[]',
  "status"                 text    NOT NULL DEFAULT 'pending',
  "version"                integer NOT NULL DEFAULT 1,
  "etag"                   text    NOT NULL,
  "candidate_id"           uuid,
  "is_finalized"           boolean NOT NULL DEFAULT false,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "reviewed_questions_status_check"
    CHECK (status IN ('pending','accepted','rejected')),
  CONSTRAINT "reviewed_questions_difficulty_check"
    CHECK (difficulty IN ('easy','medium','hard')),
  CONSTRAINT "reviewed_questions_question_type_check"
    CHECK (question_type IN ('multiple_choice','short_answer','essay','true_false')),
  CONSTRAINT "reviewed_questions_version_check"
    CHECK (version >= 1)
);
--> statement-breakpoint

CREATE INDEX "reviewed_questions_workspace_idx"
  ON "reviewed_questions" ("workspace_id");
--> statement-breakpoint

CREATE INDEX "reviewed_questions_assessment_version_idx"
  ON "reviewed_questions" ("workspace_id", "assessment_version_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "reviewed_questions_original_unique"
  ON "reviewed_questions" ("workspace_id", "original_question_id")
  WHERE "candidate_id" IS NULL;
--> statement-breakpoint

CREATE TABLE "question_audit_log" (
  "id"                     uuid    PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reviewed_question_id"   uuid    NOT NULL,
  "assessment_version_id"  uuid    NOT NULL,
  "workspace_id"           uuid    NOT NULL,
  "action"                 text    NOT NULL,
  "previous_snapshot"      jsonb,
  "next_snapshot"          jsonb,
  "actor_user_id"          uuid    NOT NULL,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "question_audit_log_action_check"
    CHECK (action IN ('created','edited','accepted','rejected','deleted','candidate_created','candidate_accepted','candidate_rejected','finalized'))
);
--> statement-breakpoint

CREATE INDEX "question_audit_log_question_idx"
  ON "question_audit_log" ("workspace_id", "reviewed_question_id");
--> statement-breakpoint

CREATE INDEX "question_audit_log_assessment_version_idx"
  ON "question_audit_log" ("workspace_id", "assessment_version_id");
--> statement-breakpoint

-- assessment_finalization: track finalization state per assessment version
CREATE TABLE "assessment_finalization" (
  "id"                     uuid    PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assessment_version_id"  uuid    NOT NULL UNIQUE,
  "workspace_id"           uuid    NOT NULL,
  "finalized_by"           uuid    NOT NULL,
  "finalized_at"           timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX "assessment_finalization_workspace_idx"
  ON "assessment_finalization" ("workspace_id", "assessment_version_id");

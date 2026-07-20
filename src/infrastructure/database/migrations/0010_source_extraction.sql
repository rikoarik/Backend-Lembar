-- B2-02 — Source extraction: passages and extraction job tracking.
--
-- Two additive tables:
--   source_passages       — immutable extracted text chunks, linked to a source_upload_versions row.
--   source_extraction_jobs — tracks per-upload extraction progress with stage/status columns.
--
-- No FK back to cross-module tables; isolation matches the uploads convention.
-- Rollback: drop source_passages, source_extraction_jobs (cascade safe — no downstream FKs yet).

CREATE TABLE "source_extraction_jobs" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "upload_id"   uuid        NOT NULL,
  "workspace_id" uuid       NOT NULL,
  "status"      text        NOT NULL DEFAULT 'pending',
  "stage"       text,
  "attempt"     integer     NOT NULL DEFAULT 0,
  "failure_code" text,
  "parser_version" text     NOT NULL DEFAULT '1',
  "page_count"  integer,
  "passage_count" integer,
  "started_at"  timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "source_extraction_jobs_status_check"
    CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  CONSTRAINT "source_extraction_jobs_stage_check"
    CHECK (stage IS NULL OR stage IN ('verifying_upload','scanning','extracting','chunking','indexing'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX "source_extraction_jobs_upload_unique"
  ON "source_extraction_jobs" ("upload_id");
--> statement-breakpoint

CREATE INDEX "source_extraction_jobs_workspace_status_idx"
  ON "source_extraction_jobs" ("workspace_id", "status");
--> statement-breakpoint

ALTER TABLE "source_extraction_jobs"
  ADD CONSTRAINT "source_extraction_jobs_upload_id_fk"
  FOREIGN KEY ("upload_id") REFERENCES "source_uploads"("id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE TABLE "source_passages" (
  "id"               uuid    PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "upload_id"        uuid    NOT NULL,
  "workspace_id"     uuid    NOT NULL,
  "extraction_job_id" uuid   NOT NULL,
  "page_number"      integer NOT NULL,
  "sequence"         integer NOT NULL,
  "text_normalized"  text    NOT NULL,
  "char_count"       integer NOT NULL,
  "content_hash"     text    NOT NULL,
  "parser_version"   text    NOT NULL DEFAULT '1',
  "created_at"       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "source_passages_page_check"   CHECK (page_number >= 1),
  CONSTRAINT "source_passages_seq_check"    CHECK (sequence >= 0),
  CONSTRAINT "source_passages_chars_check"  CHECK (char_count >= 0)
);
--> statement-breakpoint

CREATE INDEX "source_passages_upload_idx"
  ON "source_passages" ("upload_id");
--> statement-breakpoint

CREATE INDEX "source_passages_workspace_idx"
  ON "source_passages" ("workspace_id");
--> statement-breakpoint

CREATE UNIQUE INDEX "source_passages_upload_page_seq_unique"
  ON "source_passages" ("upload_id", "page_number", "sequence");
--> statement-breakpoint

ALTER TABLE "source_passages"
  ADD CONSTRAINT "source_passages_upload_id_fk"
  FOREIGN KEY ("upload_id") REFERENCES "source_uploads"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "source_passages"
  ADD CONSTRAINT "source_passages_job_id_fk"
  FOREIGN KEY ("extraction_job_id") REFERENCES "source_extraction_jobs"("id") ON DELETE CASCADE;

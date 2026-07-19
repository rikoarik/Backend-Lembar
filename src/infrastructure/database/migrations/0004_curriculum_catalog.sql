-- B1-04 — Versioned curriculum catalog (D-012)
-- Five mutable head tables + five immutable version tables.
-- A draft edit mutates only the *_current_version pointer on the head row.
-- A publish inserts a new *_versions row and advances the *_published_version pointer.
-- Public read endpoints MUST only return published content; drafts stay server-internal.

CREATE TABLE "curricula" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "code" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "level" text NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "published_version" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curricula"
  ADD CONSTRAINT "curricula_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "curricula_tenant_slug_unique" ON "curricula" USING btree ("tenant_id","slug");
--> statement-breakpoint
CREATE UNIQUE INDEX "curricula_tenant_code_unique" ON "curricula" USING btree ("tenant_id","code");
--> statement-breakpoint
CREATE TABLE "curriculum_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "curriculum_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamptz DEFAULT now() NOT NULL,
  "published_by" text
);
--> statement-breakpoint
ALTER TABLE "curriculum_versions"
  ADD CONSTRAINT "curriculum_versions_curriculum_id_curricula_id_fk"
  FOREIGN KEY ("curriculum_id") REFERENCES "public"."curricula"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "curriculum_versions_curriculum_version_unique"
  ON "curriculum_versions" USING btree ("curriculum_id","version");
--> statement-breakpoint
ALTER TABLE "curriculum_versions"
  ADD CONSTRAINT "curriculum_versions_version_check" CHECK ("version" >= 1);

CREATE TABLE "grades" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "curriculum_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "label" text NOT NULL,
  "ordering" integer DEFAULT 0 NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "published_version" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grades"
  ADD CONSTRAINT "grades_curriculum_id_curricula_id_fk"
  FOREIGN KEY ("curriculum_id") REFERENCES "public"."curricula"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "grades"
  ADD CONSTRAINT "grades_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "grades_curriculum_code_unique" ON "grades" USING btree ("curriculum_id","code");
--> statement-breakpoint
CREATE TABLE "grade_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "grade_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamptz DEFAULT now() NOT NULL,
  "published_by" text
);
--> statement-breakpoint
ALTER TABLE "grade_versions"
  ADD CONSTRAINT "grade_versions_grade_id_grades_id_fk"
  FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "grade_versions_grade_version_unique"
  ON "grade_versions" USING btree ("grade_id","version");
--> statement-breakpoint
ALTER TABLE "grade_versions"
  ADD CONSTRAINT "grade_versions_version_check" CHECK ("version" >= 1);

CREATE TABLE "phases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "grade_id" uuid NOT NULL,
  "curriculum_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "label" text NOT NULL,
  "ordering" integer DEFAULT 0 NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "published_version" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phases"
  ADD CONSTRAINT "phases_grade_id_grades_id_fk"
  FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phases"
  ADD CONSTRAINT "phases_curriculum_id_curricula_id_fk"
  FOREIGN KEY ("curriculum_id") REFERENCES "public"."curricula"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "phases"
  ADD CONSTRAINT "phases_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "phases_grade_code_unique" ON "phases" USING btree ("grade_id","code");
--> statement-breakpoint
CREATE TABLE "phase_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "phase_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamptz DEFAULT now() NOT NULL,
  "published_by" text
);
--> statement-breakpoint
ALTER TABLE "phase_versions"
  ADD CONSTRAINT "phase_versions_phase_id_phases_id_fk"
  FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "phase_versions_phase_version_unique"
  ON "phase_versions" USING btree ("phase_id","version");
--> statement-breakpoint
ALTER TABLE "phase_versions"
  ADD CONSTRAINT "phase_versions_version_check" CHECK ("version" >= 1);

CREATE TABLE "subjects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "phase_id" uuid NOT NULL,
  "grade_id" uuid NOT NULL,
  "curriculum_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "title" text NOT NULL,
  "ordering" integer DEFAULT 0 NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "published_version" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subjects"
  ADD CONSTRAINT "subjects_phase_id_phases_id_fk"
  FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subjects"
  ADD CONSTRAINT "subjects_grade_id_grades_id_fk"
  FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subjects"
  ADD CONSTRAINT "subjects_curriculum_id_curricula_id_fk"
  FOREIGN KEY ("curriculum_id") REFERENCES "public"."curricula"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subjects"
  ADD CONSTRAINT "subjects_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_phase_code_unique" ON "subjects" USING btree ("phase_id","code");
--> statement-breakpoint
CREATE TABLE "subject_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamptz DEFAULT now() NOT NULL,
  "published_by" text
);
--> statement-breakpoint
ALTER TABLE "subject_versions"
  ADD CONSTRAINT "subject_versions_subject_id_subjects_id_fk"
  FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "subject_versions_subject_version_unique"
  ON "subject_versions" USING btree ("subject_id","version");
--> statement-breakpoint
ALTER TABLE "subject_versions"
  ADD CONSTRAINT "subject_versions_version_check" CHECK ("version" >= 1);

CREATE TABLE "outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_id" uuid NOT NULL,
  "phase_id" uuid NOT NULL,
  "grade_id" uuid NOT NULL,
  "curriculum_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "text" text NOT NULL,
  "bloom_level" text NOT NULL,
  "ordering" integer DEFAULT 0 NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "published_version" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outcomes"
  ADD CONSTRAINT "outcomes_subject_id_subjects_id_fk"
  FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "outcomes"
  ADD CONSTRAINT "outcomes_phase_id_phases_id_fk"
  FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "outcomes"
  ADD CONSTRAINT "outcomes_grade_id_grades_id_fk"
  FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "outcomes"
  ADD CONSTRAINT "outcomes_curriculum_id_curricula_id_fk"
  FOREIGN KEY ("curriculum_id") REFERENCES "public"."curricula"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "outcomes"
  ADD CONSTRAINT "outcomes_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "outcomes_subject_code_unique" ON "outcomes" USING btree ("subject_id","code");
--> statement-breakpoint
CREATE TABLE "outcome_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outcome_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamptz DEFAULT now() NOT NULL,
  "published_by" text
);
--> statement-breakpoint
ALTER TABLE "outcome_versions"
  ADD CONSTRAINT "outcome_versions_outcome_id_outcomes_id_fk"
  FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_versions_outcome_version_unique"
  ON "outcome_versions" USING btree ("outcome_id","version");
--> statement-breakpoint
ALTER TABLE "outcome_versions"
  ADD CONSTRAINT "outcome_versions_version_check" CHECK ("version" >= 1);

CREATE TABLE "materials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outcome_id" uuid NOT NULL,
  "subject_id" uuid NOT NULL,
  "phase_id" uuid NOT NULL,
  "grade_id" uuid NOT NULL,
  "curriculum_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "code" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "source_rights" text NOT NULL,
  "ordering" integer DEFAULT 0 NOT NULL,
  "current_version" integer DEFAULT 1 NOT NULL,
  "published_version" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "materials"
  ADD CONSTRAINT "materials_outcome_id_outcomes_id_fk"
  FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "materials"
  ADD CONSTRAINT "materials_subject_id_subjects_id_fk"
  FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "materials"
  ADD CONSTRAINT "materials_phase_id_phases_id_fk"
  FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "materials"
  ADD CONSTRAINT "materials_grade_id_grades_id_fk"
  FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "materials"
  ADD CONSTRAINT "materials_curriculum_id_curricula_id_fk"
  FOREIGN KEY ("curriculum_id") REFERENCES "public"."curricula"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "materials"
  ADD CONSTRAINT "materials_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "materials_outcome_code_unique" ON "materials" USING btree ("outcome_id","code");
--> statement-breakpoint
ALTER TABLE "materials"
  ADD CONSTRAINT "materials_source_rights_check"
  CHECK ("source_rights" in ('license:internal','license:cc-by','license:cc-by-sa','license:cc-by-nc','license:cc-by-nd','license:unknown'));
--> statement-breakpoint
CREATE TABLE "material_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "material_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamptz DEFAULT now() NOT NULL,
  "published_by" text
);
--> statement-breakpoint
ALTER TABLE "material_versions"
  ADD CONSTRAINT "material_versions_material_id_materials_id_fk"
  FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "material_versions_material_version_unique"
  ON "material_versions" USING btree ("material_id","version");
--> statement-breakpoint
ALTER TABLE "material_versions"
  ADD CONSTRAINT "material_versions_version_check" CHECK ("version" >= 1);

-- B0-08 — Product AI provider adapter spike (additive)
--
-- Single audit/usage table for the product-runtime AI adapter. Strictly
-- additive; no existing migration is altered.

CREATE TABLE "ai_jobs_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "prompt_template_id" text NOT NULL,
  "schema_version" integer NOT NULL,
  "provider_model_id" text NOT NULL,
  "driver" text NOT NULL,
  "outcome" text NOT NULL,
  "schema_repair_attempts" integer DEFAULT 0 NOT NULL,
  "request_token_estimate" integer DEFAULT 0 NOT NULL,
  "response_token_count" integer,
  "tokens_in_estimate" bigint DEFAULT 0 NOT NULL,
  "prompt_fingerprint" text NOT NULL,
  "prompt_byte_length" integer NOT NULL,
  "response_fingerprint" text NOT NULL,
  "response_byte_length" integer,
  "redacted_error" text,
  "latency_ms" integer NOT NULL,
  "job_id" uuid,
  "redacted_detail" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_jobs_audit_driver_check" CHECK ("driver" in ('mock','openai')),
  CONSTRAINT "ai_jobs_audit_outcome_check" CHECK ("outcome" in ('succeeded','schema_repair','rate_limited','refused','error'))
);
--> statement-breakpoint
CREATE INDEX "ai_jobs_audit_workspace_idx"
  ON "ai_jobs_audit" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "ai_jobs_audit_outcome_idx"
  ON "ai_jobs_audit" USING btree ("outcome");

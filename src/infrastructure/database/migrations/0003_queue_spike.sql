CREATE TABLE "spike_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_ttl_ms" integer DEFAULT 30000 NOT NULL,
	"lease_expires_at" timestamptz,
	"heartbeat_at" timestamptz,
	"payload" jsonb NOT NULL,
	"quota_units" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamptz,
	"last_error" jsonb,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "spike_jobs_status_check" CHECK ("status" in ('created','queued','running','retry_wait','succeeded','partially_succeeded','failed','cancelled')),
	CONSTRAINT "spike_jobs_kind_check" CHECK ("kind" in ('source_ingestion','assessment_generation','question_regeneration','export_pdf'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spike_jobs_workspace_id" ON "spike_jobs" USING btree ("id");
--> statement-breakpoint
CREATE TABLE "spike_job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"worker_id" text NOT NULL,
	"outcome" text NOT NULL,
	"redacted_detail" jsonb,
	"started_at" timestamptz DEFAULT now() NOT NULL,
	"ended_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spike_idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"operation" text NOT NULL,
	"job_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spike_idempotency_scope" ON "spike_idempotency_keys" USING btree ("workspace_id","operation","key");
--> statement-breakpoint
CREATE TABLE "spike_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
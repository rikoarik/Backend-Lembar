CREATE TABLE "source_upload_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid,
	"request_id" text,
	"workspace_id" uuid NOT NULL,
	"success" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_upload_audit_action_check" CHECK ("source_upload_audit"."action" in ('intake','magic_check','size_check','access_grant','access_revoke','delete_request','delete_complete')),
	CONSTRAINT "source_upload_audit_success_check" CHECK ("source_upload_audit"."success" in ('true','false'))
);
--> statement-breakpoint
CREATE TABLE "source_upload_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"storage_driver" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"redaction_classification" text DEFAULT 'user_private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_upload_versions_version_check" CHECK ("source_upload_versions"."version" >= 1),
	CONSTRAINT "source_upload_versions_redaction_check" CHECK ("source_upload_versions"."redaction_classification" in ('public_friendly','user_private','pending_review'))
);
--> statement-breakpoint
CREATE TABLE "source_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"uploader_user_id" uuid NOT NULL,
	"filename_redacted" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"byte_size" bigint NOT NULL,
	"page_count_hint" integer,
	"magic_signature" text,
	"status" text DEFAULT 'received' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_uploads_status_check" CHECK ("source_uploads"."status" in ('received','verified','rejected','deleted'))
);
--> statement-breakpoint
ALTER TABLE "source_upload_audit" ADD CONSTRAINT "source_upload_audit_upload_id_source_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."source_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_upload_versions" ADD CONSTRAINT "source_upload_versions_upload_id_source_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."source_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_upload_audit_upload_idx" ON "source_upload_audit" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "source_upload_audit_workspace_action_idx" ON "source_upload_audit" USING btree ("workspace_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "source_upload_versions_upload_version_unique" ON "source_upload_versions" USING btree ("upload_id","version");--> statement-breakpoint
CREATE INDEX "source_uploads_workspace_idx" ON "source_uploads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "source_uploads_workspace_status_idx" ON "source_uploads" USING btree ("workspace_id","status");

CREATE TABLE "quota_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"units" integer NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "quota_reservations_state_check" CHECK ("quota_reservations"."state" in ('reserved','committed','released')),
	CONSTRAINT "quota_reservations_units_positive" CHECK ("quota_reservations"."units" > 0)
);
--> statement-breakpoint
ALTER TABLE "marketing_content" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_content" ADD COLUMN "state" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_content" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "marketing_content_versions" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_content_versions" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "quota_reservations" ADD CONSTRAINT "quota_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quota_reservations_idempotency_unique" ON "quota_reservations" USING btree ("tenant_id","workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "quota_reservations_job_id_idx" ON "quota_reservations" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "quota_reservations_tenant_id_idx" ON "quota_reservations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "quota_reservations_tenant_workspace_idx" ON "quota_reservations" USING btree ("tenant_id","workspace_id");--> statement-breakpoint
ALTER TABLE "marketing_content" ADD CONSTRAINT "marketing_content_state_check" CHECK ("marketing_content"."state" in ('draft','published','unpublished'));
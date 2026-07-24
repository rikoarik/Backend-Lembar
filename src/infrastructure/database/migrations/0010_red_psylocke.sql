CREATE TABLE "jwt_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"roles" text[] DEFAULT ARRAY['subscriber']::text[] NOT NULL,
	"workspace_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jwt_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspace_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workspace_id" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"generations_used_this_month" integer DEFAULT 0 NOT NULL,
	"billing_cycle_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_plans_plan_check" CHECK ("workspace_plans"."plan" in ('free','pro')),
	CONSTRAINT "workspace_plans_usage_non_negative" CHECK ("workspace_plans"."generations_used_this_month" >= 0)
);
--> statement-breakpoint
ALTER TABLE "jwt_users" ADD CONSTRAINT "jwt_users_workspace_id_tenants_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_plans" ADD CONSTRAINT "workspace_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_plans_workspace_unique" ON "workspace_plans" USING btree ("tenant_id","workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_plans_tenant_idx" ON "workspace_plans" USING btree ("tenant_id");
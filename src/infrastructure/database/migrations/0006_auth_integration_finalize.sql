--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "session_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_accounts_email_unique" ON "auth_accounts" USING btree ("email");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_workspace_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "role" text NOT NULL,
  "state" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_workspace_memberships_account_id_auth_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "public"."auth_accounts"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "auth_workspace_memberships_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "auth_workspace_memberships_role_check"
    CHECK ("role" in ('superadmin','school_admin','teacher','subscriber')),
  CONSTRAINT "auth_workspace_memberships_state_check"
    CHECK ("state" in ('active','suspended','revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_workspace_memberships_account_tenant_unique" ON "auth_workspace_memberships" USING btree ("account_id","tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "csrf_token" text NOT NULL,
  "session_version" integer NOT NULL,
  "idle_expires_at" timestamp with time zone NOT NULL,
  "absolute_expires_at" timestamp with time zone NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "auth_sessions_user_id_auth_accounts_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."auth_accounts"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "auth_sessions_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "auth_sessions_state_check" CHECK ("state" in ('active','revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id","id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_recovery_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_recovery_tokens_user_id_auth_accounts_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."auth_accounts"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "auth_recovery_tokens_state_check" CHECK ("state" in ('pending','consumed','expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_recovery_tokens_hash_unique" ON "auth_recovery_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_school_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "email" text NOT NULL,
  "role" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_school_invitations_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "auth_school_invitations_accepted_by_auth_accounts_id_fk"
    FOREIGN KEY ("accepted_by") REFERENCES "public"."auth_accounts"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "auth_school_invitations_role_check"
    CHECK ("role" in ('superadmin','school_admin','teacher','subscriber')),
  CONSTRAINT "auth_school_invitations_state_check"
    CHECK ("state" in ('pending','accepted','expired','revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_school_invitations_hash_unique" ON "auth_school_invitations" USING btree ("token_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "action" text NOT NULL,
  "user_id" uuid,
  "tenant_id" uuid,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" text,
  CONSTRAINT "auth_audit_events_user_id_auth_accounts_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."auth_accounts"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "auth_audit_events_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "auth_audit_events_action_check"
    CHECK ("action" in ('register','login','logout','logout_all','recovery_request','recovery_complete','role_change','membership_suspended','workspace_switch','invitation_create','invitation_accept'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_audit_events_action_idx" ON "auth_audit_events" USING btree ("action","id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_rate_limits" (
  "key" text PRIMARY KEY NOT NULL,
  "count" integer NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL
);

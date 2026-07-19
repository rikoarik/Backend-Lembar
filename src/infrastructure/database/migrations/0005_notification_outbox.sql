-- B0-09 — Transactional notification provider spike (D-007)
-- Additive tables only. Production provider selection is deferred; the only driver is memory.

CREATE TABLE "notification_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_key" text NOT NULL,
  "locale" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "subject" text NOT NULL,
  "body_text" text NOT NULL,
  "body_html" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_templates_key_locale_version_unique"
  ON "notification_templates" USING btree ("template_key","locale","version");
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL,
  "template_key" text NOT NULL,
  "locale" text DEFAULT 'id-ID' NOT NULL,
  "recipient_hash" text NOT NULL,
  "recipient_kind" text NOT NULL,
  "payload_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "visible_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "sent_at" timestamptz,
  CONSTRAINT "notification_outbox_status_check" CHECK ("status" in ('pending','sending','sent','failed')),
  CONSTRAINT "notification_outbox_recipient_kind_check" CHECK ("recipient_kind" in ('email','sms'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_event_id_unique"
  ON "notification_outbox" USING btree ("event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_sent_dedupe_unique"
  ON "notification_outbox" USING btree ("template_key","recipient_hash","payload_hash")
  WHERE "status" = 'sent';
--> statement-breakpoint
CREATE TABLE "notification_send_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "outbox_id" uuid,
  "adapter" text NOT NULL,
  "status" text NOT NULL,
  "redacted_recipient" text NOT NULL,
  "redacted_subject_hash" text,
  "latency_ms" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "notification_send_audit_adapter_check" CHECK ("adapter" = 'memory'),
  CONSTRAINT "notification_send_audit_status_check" CHECK ("status" in ('dispatched','failed'))
);
--> statement-breakpoint
ALTER TABLE "notification_send_audit"
  ADD CONSTRAINT "notification_send_audit_outbox_id_notification_outbox_id_fk"
  FOREIGN KEY ("outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "notification_templates" ("template_key", "locale", "version", "subject", "body_text", "body_html") VALUES
  ('auth.recovery', 'id-ID', 1, 'Kode pemulihan kata sandi', 'Gunakan kode {{ code }} untuk memulihkan kata sandi Anda.', NULL),
  ('auth.recovery', 'en-US', 1, 'Password recovery code', 'Use code {{ code }} to recover your password.', NULL),
  ('workspace.invite', 'id-ID', 1, 'Undangan ke {{ workspace_name }}', '{{ inviter_name }} mengundang Anda ke {{ workspace_name }}. Terima undangan: {{ accept_url }}', NULL),
  ('workspace.invite', 'en-US', 1, 'Invitation to {{ workspace_name }}', '{{ inviter_name }} invited you to {{ workspace_name }}. Accept the invitation: {{ accept_url }}', NULL);

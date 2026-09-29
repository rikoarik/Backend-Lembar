-- BUG-19 — `POST /v1/sources/upload-intents` + `PUT /v1/uploads/sources/{id}/content`
-- introduce two upload-lifecycle audit transitions that the one-shot intake path
-- did not have:
--
--   intent_create  — a private upload slot was reserved (no bytes yet)
--   content_store  — the client PUT the bytes and the row moved to `verified`
--
-- The `source_upload_audit_action_check` constraint from 0009 only allowed the
-- original seven actions, so the audit write for either transition would have
-- failed the check and turned a successful upload into a 500.
--
-- Additive and idempotent: drop-then-add the same named constraint.
-- Rollback: restore the 0009 constraint body (seven actions).
--
-- NOTE: `upload_id` stays NOT NULL here. `createIntent` deliberately does not
-- audit pre-row validation failures (unsupported content type, bad declared
-- size) rather than widening the column; the one-shot `intake` path still
-- depends on that column being non-null.

ALTER TABLE "source_upload_audit"
  DROP CONSTRAINT IF EXISTS "source_upload_audit_action_check";
--> statement-breakpoint
ALTER TABLE "source_upload_audit"
  ADD CONSTRAINT "source_upload_audit_action_check"
  CHECK ("action" IN (
    'intake',
    'magic_check',
    'size_check',
    'access_grant',
    'access_revoke',
    'delete_request',
    'delete_complete',
    'intent_create',
    'content_store'
  ));

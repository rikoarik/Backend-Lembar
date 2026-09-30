-- BUG-20b — school invitation accept for a brand-new email.
--
-- `auth_school_invitations.accepted_by` was created in 0006 referencing
-- `auth_accounts(id)`, but the account created by accepting an invitation lives
-- in `jwt_users` — the only table the live JWT auth stack reads and writes
-- (`auth_accounts` holds 342 legacy rows that no active endpoint touches).
-- Postgres therefore rejected the UPDATE that burns the token with:
--
--   insert or update on table "auth_school_invitations" violates foreign key
--   constraint "auth_school_invitations_accepted_by_auth_accounts_id_fk"
--
-- which surfaced as a 500 INTERNAL_ERROR even once the NOT NULL insert into
-- `jwt_users` was fixed.
--
-- `accepted_by` is provenance for the audit trail, not an authorization input,
-- so the forward fix is to drop the FK instead of duplicating identity into the
-- dead `auth_accounts` table. The column stays; its invariant becomes "id of the
-- `jwt_users` row that accepted the invitation", and both the Postgres and
-- in-memory stores write exactly that.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS, so re-applying is a no-op.
--
-- Rollback: the constraint can be re-added only if `accepted_by` holds NULLs or
-- `auth_accounts` ids. Existing rows reference `jwt_users` ids, so a rollback
-- must first run `UPDATE auth_school_invitations SET accepted_by = NULL`.

ALTER TABLE "auth_school_invitations"
  DROP CONSTRAINT IF EXISTS "auth_school_invitations_accepted_by_auth_accounts_id_fk";

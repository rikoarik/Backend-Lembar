-- BUG-21: logout had no server-side effect. The JWT is stateless with a 7-day
-- lifetime, so clearing cookies on the client left the token fully usable
-- (GET /v1/me still answered 200 with the "logged out" token).
--
-- Revocation is version-based: every JWT carries the `sv` claim it was minted
-- with, and the auth middleware rejects a token whose `sv` no longer matches
-- `jwt_users.session_version`. Logout increments the column, which invalidates
-- every token previously issued for that account.
--
-- Tokens minted before this migration carry no `sv` claim; they are read as
-- sv = 1, so nothing breaks on deploy — but they are revoked by the first
-- logout, because that logout moves the column to 2.
ALTER TABLE "jwt_users"
  ADD COLUMN IF NOT EXISTS "session_version" integer NOT NULL DEFAULT 1;

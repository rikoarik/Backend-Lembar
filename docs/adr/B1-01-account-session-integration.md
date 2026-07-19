# B1-01 — Account and session integration

## Decision

Web V1 keeps the existing internal auth module from B0-05 instead of introducing a third-party auth library.

## Why now

- **D-002** remains satisfied by the current internal auth/service contract.
- **D-007** is now satisfied by the accepted B0-09 notification adapter/outbox integration for `auth.recovery` and `workspace.invite`.
- The shortest safe path was to harden persistence and delivery without changing the external auth route semantics.

## What changed

- Auth users, memberships, sessions, recovery tokens, invitations, audits, and rate limits persist in Postgres under `auth_*` tables.
- Recovery requests and school invitations emit through the notification outbox/adapter boundary.
- The service continues to enforce origin allowlist, CSRF, session-cookie, workspace membership checks, enumeration-safe recovery/register responses, and session-version revocation.
- Tests and smoke now obtain one-time recovery/invite tokens only from the in-memory notification seam used for verification, not from service return payloads.

## Deferred

- Mobile bearer-token authentication remains explicitly out of scope.
- Runtime auto-wiring of auth DB storage from the API bootstrap remains deferred until it can be done in an allowed task surface.

## Revisit criteria

A future migration to a third-party auth library is justified only when at least one of these becomes true:

1. Web auth requirements expand beyond email/password + workspace session switching (for example OAuth, SSO, passkeys, or delegated identity flows).
2. Session/device management requirements exceed the current internal module's safe maintenance ceiling.
3. Compliance or operational requirements demand provider features the current module cannot supply without disproportionate bespoke code.
4. The repository accepts a new ADR explicitly authorizing a library/provider choice.

skipped: third-party auth adoption, add when an ADR explicitly accepts a provider.

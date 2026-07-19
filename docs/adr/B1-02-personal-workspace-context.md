# B1-02 — Personal Workspace Context

## Status

Accepted for B1-02 implementation.

## Context

Authenticated requests need a persisted workspace context before tenant-scoped product modules can rely on `X-Workspace-Id` or session state. Registration, login, recovery, `/v1/me`, and workspace switching must not trust only in-memory assumptions.

## Decision

Personal workspace creation stays inside the auth service and reuses the existing `tenants` table plus `auth_workspace_memberships`.

On first account creation, `AuthService.register` runs account insert, personal tenant insert, membership insert, and register audit in one `AuthStore.transaction`. If any write fails, the transaction rolls back and leaves no account or orphan personal workspace residue.

Duplicate registration remains enumeration-safe. For a pre-existing account with no active membership, the service repairs the missing personal workspace context in the same transaction helper before returning the generic accepted response.

`GET /v1/me` now returns the session-backed active workspace context through the auth service: account summary, active workspace id, and persisted workspace summaries. Workspace switching still validates active membership against the store before updating the session tenant.

## Deferred

School workspace expansion remains invitation/member driven. No new workspace type table, school provisioning flow, or provider/runtime auth decision is introduced here.

## Rollback

Revert the auth service/store/router/test changes and this ADR. No migration is required because B1-02 uses the existing B1-01 auth and B0-04 tenant tables.

# ADR B1-03 — Permission and tenant adversarial suite

## Status
Accepted

## Context
B1-01 introduced session-backed auth and B1-02 established personal workspace context. The current backend surface is still small, but the safety requirements are already fixed: requests must not cross tenant boundaries, workspace switching must stay membership-bound, `/v1/me` must never resolve a foreign workspace, and invitation management must rely on reusable permission logic instead of route-local branching.

## Decision
- Keep the reusable permission map in `src/modules/auth/policy/Permissions.ts` and add a shared `hasPermission(role, permission)` helper.
- Use that helper in auth application flows that need authorization decisions today, starting with school invitation creation via `workspace.member.manage`.
- Keep workspace isolation enforced in the auth service layer by validating active membership on session resolution and workspace switching.
- Add adversarial tests around service and HTTP flows to prove:
  - foreign-tenant workspace IDs are denied,
  - non-member workspace switches are denied,
  - `/v1/me` remains scoped to the caller's memberships,
  - tampered session workspace state is rejected,
  - invitation management respects reusable permission policy.

## Consequences
- Current auth-facing routes now share one permission helper instead of embedding one-off role checks.
- Tenant isolation behavior is locked in with regression coverage before broader resource modules depend on it.
- Bahasa error envelopes, CSRF/origin protections, and redaction behavior remain unchanged.

## Deferred
- Broader resource modules outside auth are not yet wired to `hasPermission`; they should adopt the same helper as their route/service surfaces land.
- Dedicated list-query leakage tests for future resource collections remain deferred until those list/read endpoints exist.
- A fuller role/permission matrix ADR can wait until non-auth modules introduce resource-specific permissions beyond the current foundation.

# ADR — B1-05 Current context and dashboard read API

Status: Accepted for B1-05 implementation
Date: 2026-07-19

## Context

The authenticated frontend needs a stable read model for the current account, available workspaces, active workspace, and an initial dashboard summary. B1-03 established membership-gated workspace access, and B1-04 established catalog foundations. Assessment, source, and job projections are still future slices.

## Decision

- `/v1/me` remains backward compatible and adds stable context fields:
  - `activeWorkspace` mirrors the active membership-scoped workspace summary.
  - `context.workspaceIds` lists only active memberships visible to the session user.
  - `context.permissionSet` exposes permissions derived from the active membership role.
  - each workspace summary includes `permissions` and `isActive`.
- `/v1/dashboard/summary` returns a read-only active-workspace summary scoped through the current session membership.
- Initial dashboard metrics are explicit zero-count projections:
  - `assessments`: `total`, `draft`, `inReview`, `final`.
  - `sources`: `total`, `ready`, `processing`, `failed`.
  - `jobs`: `total`, `active`, `failed`.
- Empty state is first-class: `emptyState.isEmpty=true` and an Indonesian message when no dashboard-backed activity exists.

## Security and privacy

All reads start from the session cookie and call the same session/membership validation as workspace switching. The API never accepts a tenant id for dashboard summary, so it cannot be pointed at a foreign workspace. Responses contain account id, display name, workspace ids/names/roles, and derived permission keys only; no secrets, tokens, source content, or provider data are returned.

## Deferred

Richer dashboard counts from assessment/source/job tables are deferred until those write/read models exist. When added, each projection must filter by the validated active workspace id and preserve the same response shape.
# ADR B1-06 — Published-only marketing read API

- Status: Accepted
- Date: 2026-07-19
- Depends on: B0-03, B0-04

## Context

Lembar needs unauthenticated marketing reads for global chrome and public pages. This task must use the existing Fastify + PostgreSQL stack, avoid new packages, keep draft content private, and defer CMS authoring flows to B6-06.

## Decision

Use a versioned PostgreSQL marketing content model with two tables:

- `marketing_content`: mutable head row per `{kind, slug, locale}` carrying `current_version`, nullable `published_version`, and optional `draft_payload`
- `marketing_content_versions`: immutable published snapshots keyed by `(content_id, version)`

Expose only published reads:

- `GET /v1/public/marketing/global`
- `GET /v1/public/marketing/pages/{slug}`

Both endpoints are unauthenticated, `id-ID` only, return stable error envelopes, emit ETags from canonical JSON bytes, and answer `304 Not Modified` when `If-None-Match` matches. Draft payloads are never served from these routes.

## Consequences

### Positive
- Draft and unpublished content stay undisclosed by construction.
- Reads use the existing app/database stack; no queue or worker dependency is introduced.
- Immutable version rows give stable cache validators and support later CMS publish flows.

### Deferred
- Superadmin draft save/preview/publish/unpublish/restore remains in B6-06.
- Multi-locale authoring is deferred; current public read only accepts `id-ID`.
- Rich schema evolution/migrations for editor tooling are deferred until authoring exists.

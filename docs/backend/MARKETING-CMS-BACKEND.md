# Marketing CMS Backend Contract

## Architecture

Marketing CMS is one module inside Backend-Lembar's modular monolith. It uses the existing
HTTP process, PostgreSQL connection, auth/authorization, audit, migration, and observability
facilities. It does not introduce a CMS service, queue, worker, Redis dependency, or vendor.

Suggested module boundaries:

- domain: page identity, version state, supported schema, invariants;
- application: save draft, preview, publish, unpublish, restore;
- adapters/http: public and ops endpoints;
- adapters/persistence: PostgreSQL repositories;
- policy: superadmin authorization and decision-gated validation.

No internal HTTP calls. Other modules depend on application interfaces, not tables.

## Persistence

marketing_pages:

- id, slug, locale, current_published_version_id, created_at, updated_at;
- unique slug + locale.

marketing_page_versions:

- id, page_id, version_number, schema_version, state;
- content_json, seo_json;
- revision, created_by, created_at, published_by, published_at;
- immutable after publish.

marketing_global_sets / marketing_global_versions:

- versioned navigation, footer, global CTA, and default SEO using the same workflow.

marketing_media_assets:

- optional metadata/reference to the shared media/storage facility;
- publication requires ready status and valid ownership/policy.

AuditEvent remains the canonical audit record. Do not duplicate secret/session or full
content payloads into audit metadata.

## State

draft -> published -> superseded

- Saving a draft increments revision.
- Publishing creates/marks an immutable version and atomically updates the page pointer.
- Unpublish clears the public pointer through an audited command; fallback behavior remains
  frontend-owned.
- Restore copies an old published version into a new draft.
- If-Match/revision mismatch returns 409 CMS_REVISION_CONFLICT.

## API behavior

Public:

- unauthenticated, published only;
- locale and slug allowlisted;
- ETag and Cache-Control;
- 404 does not reveal draft existence;
- no editor/audit metadata.

Ops:

- authenticated superadmin only;
- CSRF/origin protection for browser mutation;
- rate limiting for preview/publish;
- no Workspace-Id authorization shortcut;
- preview response uses no-store;
- publish and restore may require step-up according to auth policy.

## Content safety

- Reject arbitrary HTML, script, style, iframe, event handlers, data/javascript URLs, and
  unknown block/component identifiers.
- CTA URL schemes: relative application path or allowlisted https destination.
- Sanitize filenames/metadata and validate media readiness.
- Enforce maximum document/block/text sizes.
- Decision-gated fields such as price require an accepted product decision/config flag.

## Performance

- Public read is one indexed pointer/version lookup plus global set lookup.
- Conditional GET returns 304 for matching ETag.
- Cache-Control target: max-age=60, stale-while-revalidate=300.
- No queue/worker for CRUD or publish.
- Add Redis only through a later ADR backed by measured need.

## Tests

- State transition and immutable published version.
- Visitor/teacher/school_admin forbidden on ops endpoints.
- Superadmin success plus complete audit.
- Concurrent revision conflict.
- Unsafe content/URL/oversize rejection.
- Draft never visible through public API.
- ETag/304/cache headers.
- Transaction rollback when publish pointer/audit fails.

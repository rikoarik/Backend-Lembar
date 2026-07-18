# START B6-06 — Superadmin CMS authoring

Work only in Backend-Lembar after B1-06 and B6-03 are accepted. Read only:

1. exact B6-06 task contract;
2. docs/backend/MARKETING-CMS-BACKEND.md;
3. docs/product/BUSINESS-ROLES-PERMISSIONS.md;
4. executable OpenAPI.

Implement superadmin-only list/get draft, save, preview, publish, unpublish, and
restore-as-new-draft commands. Enforce CSRF/origin, revision/If-Match, immutable published
versions, no-store preview, decision-gated price/claim fields, and transactionally consistent
audit.

Do not build frontend, scheduled publishing, arbitrary HTML/page builder, queue/Redis, media
upload, or tenant-specific marketing. Test every role, conflict, unsafe content, audit rollback,
and draft nondisclosure. Update OpenAPI/contract artifacts.

Commit locally; do not push/merge/deploy/start another task. Handoff <= 500 words.

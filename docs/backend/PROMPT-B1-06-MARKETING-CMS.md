# START B1-06 — Marketing content domain and public API

Work only in Backend-Lembar. Read only:

1. exact B1-06 contract in TASK-REGISTRY.yaml;
2. docs/backend/MARKETING-CMS-BACKEND.md;
3. docs/product/BUSINESS-ROLES-PERMISSIONS.md;
4. executable OpenAPI baseline.

Implement the lightweight marketing-content module, migrations, validated seed, and
published-only global/page read endpoints with ETag/304/cache headers.

Do not implement ops authoring UI/API, queue, Redis, worker, media upload, third-party CMS,
frontend, or unrelated refactors. Do not decide an open ORM/framework choice; stop if its gate
is unresolved.

Test migration/constraints, draft nondisclosure, schema/URL rejection, ETag/304, public cache,
and no workspace authorization dependency. Update executable OpenAPI and contract tests.

Commit locally on the task branch. Do not push, merge, deploy, or start B6-06. Return a handoff
under 500 words with commands, migration/API impact, limitations, and READY_FOR_OWNER_REVIEW.

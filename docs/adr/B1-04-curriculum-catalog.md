# B1-04 — Versioned curriculum catalog (D-012)

Status: READY_FOR_OWNER_REVIEW (B1-04)

## Scope delivered

- Resolves decision candidate D-012 (versioned curriculum catalog model) with an
  immutable-version persistence shape: each of the five curriculum resources
  (`curricula`, `grades`, `phases`, `subjects`, `outcomes`, `materials`) is a
  pair of tables — a mutable *head* row carrying `current_version` and
  `published_version` pointers, and an append-only `*_versions` table keyed by
  `(parent_id, version)`.
- Drizzle schema (`src/modules/curriculum/persistence/schema.ts`) and SQL
  migration `0004_curriculum_catalog.sql` (applied via `pnpm db:check` /
  `pnpm db:migrate`) introduce twelve tables with cascading tenant FKs,
  uniqueness on `(parent, code)` / `(tenant, slug)`, `CHECK (version >= 1)` on
  every version table, and a `materials.source_rights` CHECK constraint that
  enforces the canonical license enum server-side.
- HTTP surface (`src/modules/curriculum/adapters/http/routes.ts`) mounts six
  verbs per resource (create draft, upsert draft, publish, list versions,
  read version, public projection) plus a single cross-cutting
  `POST /v1/curriculum/{resource}/{id}/source-rights-gate` evaluator. Public
  reads honor `If-None-Match` against the deterministic ETag computed from the
  published payload; drafts are never returned or logged.
- Tenant isolation: every head row carries a `tenant_id` (or a denormalized
  copy inherited from the parent), and every read path filters by that key. The
  public `GET /v1/curriculum/curricula/:tenantSlug` projection explicitly joins
  through `tenants.slug` so cross-tenant requests return `404 Resource tidak
  ditemukan.`
- TypeScript domain: `CurriculumRepository` (pure Drizzle + node-postgres
  query layer with parent inheritance for grade/phase/subject/outcome/material
  chain), `VersioningService` (draft/publish/list/get/projection logic with
  Bahasa stable error envelopes), and `src/config/curriculum.env.ts` for the
  typed env parser (`CURRICULUM_WRITE_TOKEN`,
  `CURRICULUM_SOURCE_RIGHTS_ALLOWLIST`).
- Tests: `test/modules/curriculum/versioning.test.ts` covers all eight contract
  scenarios (draft-write stability, atomic publish, concurrent serialization,
  source-rights gate, projection filtering, ETag determinism, paginated 100-cap
  history, cross-tenant isolation) plus a route-layer bearer guard test.
  `test/modules/curriculum/source-rights.test.ts` is a parametrized matrix of
  the seven license values, asserting only `license:internal`, `license:cc-by`,
  and `license:cc-by-sa` pass.
- Smoke: `pnpm curriculum:smoke` (`src/smoke/curriculum.ts`) applies the
  migration, walks the full draft → publish chain for every resource, exercises
  the source-rights gate, reads the public projection, and validates ETag
  `304` round-trips. Output is redacted — no bearer tokens, no DSNs, no DDL.
- OpenAPI: `contracts/openapi.yaml` is extended additively with the new
  `/v1/curriculum/*` paths (32 new endpoints), parameters (`IfNoneMatch`,
  `ResourceId`, `WriteBearer`), and schemas. `pnpm openapi:validate` and
  `pnpm openapi:breaking` both pass: 32 additive, **0 breaking**.
- No new packages. `pnpm-lock.yaml` is unchanged.

## Design choices

### Immutable-version model

Each publish writes a new row into the version table with a monotonically
increasing integer version, scoped by `(parent_id, version)`. The
uniqueness constraint serializes concurrent publishers — the second
insert raises `unique_violation` and the service maps it to a `STATE_CONFLICT`
response. The mutable head row keeps two pointers: `current_version` (the
latest published *or* drafted snapshot) and `published_version` (only ever
advances when a publish succeeds). Draft edits increment `current_version`
*without* inserting into the version table.

This shape was chosen over an event-sourced ledger because it satisfies the
D-012 requirement to keep draft edits server-internal while making publish a
single SQL insert + update inside one transaction. The cost is one extra row
per publish per resource; the benefit is that reads are O(1) joins against a
small, append-only history table that is also the source of truth for the
public projection.

### Why this API stays unauthenticated (vs. B1-03)

The contract intentionally allows public marketing pages and the future
public-school-directory to consume `GET /v1/curriculum/curricula/:tenantSlug`
without a session. Reads expose only `published_version` content; drafts and
version-history endpoints (`/:id/versions/*`) are also public because
publishing a version is the public act. All write paths require a stub bearer
header (`Authorization: Bearer …`) which the B1-03 permission layer will
replace with full tenant/session checks. The stub guard fails closed — a
missing or mismatched bearer returns `AUTH_REQUIRED` with the Bahasa stable
envelope. This is the smallest auth surface that lets us land D-012 without
blocking on B1-03; it is *not* a final permission model.

### ETag strategy

ETags are `"sha256:<hex>"` over a stable JSON serialization of the published
payload (sorted keys, no whitespace). Computation lives in
`etagForPayload()` inside the repository module and is reused by both the
public projection and per-version reads, so `If-None-Match` round-trips work
identically for both. Drafts are excluded from ETag keys by construction —
only `published_version` content is fed to the hash.

### Source-rights gate

`materials.source_rights` is constrained at the DB level to the canonical
enum (`license:internal`, `license:cc-by`, `license:cc-by-sa`,
`license:cc-by-nc`, `license:cc-by-nd`, `license:unknown`). Publishing any
material whose rights are not in the approved allowlist (the first three)
raises a typed validation error inside the publish transaction, surfacing as
a `400 VALIDATION_FAILED` envelope. The same gate is exposed as an
explicit `POST /v1/curriculum/{resource}/{id}/source-rights-gate` endpoint so
CMS operators can pre-check before clicking publish.

## Files

```
src/config/curriculum.env.ts                              # typed env parser
src/modules/curriculum/
  persistence/schema.ts                                   # Drizzle schema
  domain/CurriculumRepository.ts                          # data access + ETag
  domain/VersioningService.ts                             # draft/publish/gate
  adapters/http/routes.ts                                 # Fastify route registration
  adapters/http/schema.ts                                 # body/header helpers
src/smoke/curriculum.ts                                   # pnpm curriculum:smoke
src/infrastructure/database/migrations/
  0004_curriculum_catalog.sql                             # additive migration
  meta/0004_snapshot.json                                 # regen via drizzle-kit
test/modules/curriculum/
  versioning.test.ts                                      # 8 contract scenarios
  source-rights.test.ts                                   # license matrix
docs/adr/B1-04-curriculum-catalog.md                      # this file
contracts/openapi.yaml                                    # +32 additive paths
```

## Verification commands (run in order)

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test
pnpm openapi:validate
pnpm openapi:breaking        # 32 additive, 0 breaking
pnpm db:check
DATABASE_URL=postgres://lembar@127.0.0.1:55443/lembar DATABASE_REQUIRED=true pnpm db:smoke
pnpm curriculum:smoke
```

## Deferred items (intentionally out of scope for B1-04)

- **School-level overrides.** The catalog model is tenant-scoped, not
  school-scoped. School-specific overrides will land in a later task once
  AUTH-TENANCY-SPEC is updated to define the override semantic (replace vs.
  layer on top of the tenant default).
- **Public-school-directory projection.** This task ships a single
  `GET /v1/curriculum/curricula/:tenantSlug` endpoint for tenant-wide
  consumption. The public directory will need a denormalized, cached read
  model and a separate route — both deferred to B2-series tasks.
- **Visual curriculum maps (CMS side).** Front-end rendering of the
  curriculum tree (curriculum → grade → phase → subject → outcome → material)
  as navigable maps is a CMS/UI concern, not a backend one.
- **Worker-driven publish/snapshot.** This task is synchronous request/response
  only. B0-06 owns the worker boundary; a future worker job can move heavy
  publish batches (e.g., bulk material imports) off the request path.
- **Object storage of curriculum assets.** D-006 is still open and is handled
  in B2-01. B1-04 is metadata + versioning only — no file blobs.

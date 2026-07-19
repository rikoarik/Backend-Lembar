# Backend-Lembar

Modular monolith for `lembar` (API + worker) — see `AGENTS.md`,
`docs/backend/README.md`, and `docs/backend/BACKEND-ARCHITECTURE.md`.

## Foundation baseline (B0-01 + B0-02 + B0-03)

- One pnpm package, Node 22 LTS pin (`.nvmrc`, `engines`).
- Direct Fastify API entrypoint with `GET /health` on port `4000`.
- Per-process typed env schemas: `src/config/base.env.ts`, `api.env.ts`, `worker.env.ts`.
- `parseBaseEnv` / `parseApiEnv` / `parseWorkerEnv` validate once at bootstrap and return
  typed objects; unknown enum values or out-of-range numbers throw `ConfigError`.
- Redaction: config errors list key names and reasons only — values are never logged or surfaced.
- Strict production mode: `APP_ENV=production` requires `PUBLIC_APP_URL`; no production secret
  is required for local install/typecheck/unit.
- Stable `ErrorEnvelope` + request-id propagation for 404/internal responses.
- Published OpenAPI artifact + checksum + breaking-change detector under `contracts/`.
- Worker entrypoint emits one structured, secret-free heartbeat and exits `0`.
- TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- ESLint flat config + Prettier; Vitest for unit and smoke tests.
- Folder skeleton per `BACKEND-ARCHITECTURE.md`. No fake business modules.

## B0-07 spike scaffolding

This branch adds reversible seams for two still-open decisions:

- **D-006 object storage**
  - `src/infrastructure/storage/StorageAdapter.ts`
  - drivers: `memory` and `local`
- **D-020 PDF rendering**
  - `src/infrastructure/pdf/RenderAdapter.ts`
  - drivers: `stub` and disabled `playwright`

The spike is intentionally local-only. It does **not** choose a production storage
provider, install Playwright/Chromium, or emit real PDFs yet.

See `docs/adr/B0-07-spike.md` for the boundary and owner questions.

## Scripts

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm openapi:validate
pnpm openapi:breaking
pnpm storage:smoke
pnpm pdf:smoke
pnpm auth:smoke                       # B0-05 auth/session spike (redacted)
pnpm ai:smoke                         # B0-08 product AI adapter spike (redacted)
pnpm db:check                       # drizzle-kit: validate generated SQL
pnpm db:smoke                       # real Postgres roundtrip smoke (DATABASE_URL required)
node dist/bootstrap/api.js          # API on :4000
node dist/bootstrap/worker.js       # one heartbeat, exit 0
```

`pnpm openapi:validate` validates `contracts/openapi.yaml` and rewrites
`contracts/openapi.checksum.txt`. `pnpm openapi:breaking` compares the
current artifact against `contracts/openapi.previous.yaml` and exits `1`
on breaking changes.

`contracts/openapi.yaml` is the published contract source. Keep
`contracts/openapi.previous.yaml` checked in as the accepted comparison
baseline until a newer artifact is intentionally promoted.

The app echoes/creates `X-Request-Id` and returns the stable envelope on
unknown routes and internal errors:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Resource tidak ditemukan.",
    "requestId": "req_...",
    "retryable": false
  }
}
```

Unknown/internal details stay redacted.

## Configuration

`.env.example` lists non-secret defaults consumed by the typed parsers in
`src/config/`. Key boundaries:

- `base.env.ts` — `NODE_ENV`, `APP_ENV`, `SERVICE_NAME`, `SERVICE_VERSION`, `LOG_LEVEL`.
- `api.env.ts` — `API_PORT`, `API_HOST`, `CORS_ALLOWED_ORIGINS`, `PUBLIC_APP_URL`,
  reuses `LOG_LEVEL` from base.
- `worker.env.ts` — `WORKER_NAME`, `WORKER_CONCURRENCY`, reuses `LOG_LEVEL` from base.
- `database.env.ts` — `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_SSL_MODE`,
  `DATABASE_REQUIRED`.

Strict production mode is opt-in via `APP_ENV=production`. Secrets (DB URLs, auth
signing keys, AI/storage/payment keys, webhook secrets) are not configured here —
they are added per process by later tasks and must never be committed.

## Database spike (B0-04)

- ORM baseline: Drizzle ORM (D-003) over node-postgres with migrations under
  `src/infrastructure/database/migrations/`.
- Typed env: `src/config/database.env.ts` validates `DATABASE_URL`, `DATABASE_POOL_MAX`,
  `DATABASE_SSL_MODE`, `DATABASE_REQUIRED`. Errors list key names only — values are
  never logged.
- Drizzle schema: `tenants`, `users`, `schools` (`src/infrastructure/database/schema.ts`)
  — minimal spike tables only, with DB-side tenant FKs and a `users.role` CHECK constraint.
- CLI surface:
  - `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:push` / `pnpm db:check` — Drizzle Kit.
  - `pnpm db:smoke` — build then run the real-DB roundtrip smoke (`src/smoke/database.ts`).
- Local disposable Postgres only. Production secrets are never committed.
- See `docs/adr/B0-04-spike.md` for deferred items and owner-open questions.

## Auth spike (B0-05)

- `src/modules/auth/` is the local-only auth/session spike layered on Fastify and Drizzle. It
  reuses the B0-04 `tenants` and `users` tables and adds `auth_sessions`,
  `auth_recovery_tokens`, `auth_school_invitations`, and `auth_audit_events` tables
  (additive, no B0-04 migration is altered in this spike).
- HTTP routes expose `POST /v1/auth/{register,login,logout,recovery/*,invitations/consume}`
  and `POST /v1/auth/workspace/switch` plus `GET /v1/me`. State-changing browser
  requests are guarded by an `Origin` allowlist and a double-submit CSRF token.
- Sessions ride an HttpOnly Secure `__Host-lembar_session` cookie plus a
  `lembar_csrf` cookie. Recovery/invite tokens are stored hashed and are single-use.
- Run `pnpm auth:smoke` for a CLI end-to-end smoke (redacted JSON output, exits `0`).
- See `docs/adr/B0-05-spike.md` for the D-002 decision, owner-open questions, and
  rollback notes.

## Queue spike (B0-06)

- D-004 spike chooses the Postgres-only queue path for this repo shape: no extra runtime store,
  reuse Drizzle/Postgres transaction boundaries, and keep local/test operation possible without
  Redis.
- Local proof surface: `test/infrastructure/queue/queue-spike.test.ts` (14 acceptance items)
  and `pnpm queue:smoke` (`src/smoke/queue.ts`).
- Queue persistence schema is isolated in `src/infrastructure/queue/persistence/schema.ts`; it
  does not modify auth-owned columns in `src/infrastructure/database/schema.ts`.
- BullMQ/Redis remains a documented stub seam only (`src/infrastructure/queue/adapters/bullmq/`).
- See `docs/adr/B0-06-spike.md` for the decision, footprint, and rollback notes.

## Curriculum catalog (B1-04)

- D-012 versioned curriculum catalog: five mutable head tables (`curricula`, `grades`, `phases`,
  `subjects`, `outcomes`, `materials`) plus five immutable `*_versions` tables. A draft edit
  mutates only the head row's `current_version`; a publish inserts a new version row and
  advances `published_version`. Uniqueness on `(parent_id, version)` serializes concurrent
  publishes; `CHECK (version >= 1)` enforces monotonicity.
- HTTP surface under `/v1/curriculum/*` (`src/modules/curriculum/adapters/http/routes.ts`):
  public read endpoints (`GET .../:tenantSlug`, `GET .../:id/versions[/:version]`) honor
  `If-None-Match` against a deterministic `sha256`-of-payload ETag. Write endpoints require a
  stub `Authorization: Bearer …` header (the B1-03 permission layer will replace it).
  Drafts never appear in any read response or in any log.
- Source-rights gate: `POST /v1/curriculum/{resource}/{id}/source-rights-gate` plus a server
  check inside the publish transaction. Only `license:internal`, `license:cc-by`, and
  `license:cc-by-sa` pass; everything else returns `400 VALIDATION_FAILED` with the Bahasa
  stable envelope.
- Migration `src/infrastructure/database/migrations/0004_curriculum_catalog.sql` is additive;
  no prior migration is altered.
- Tests: `test/modules/curriculum/versioning.test.ts` (8 scenarios — draft stability, atomic
  publish, concurrent serialization, source-rights gate, draft filtering, ETag determinism,
  paginated 100-cap history, cross-tenant isolation) and
  `test/modules/curriculum/source-rights.test.ts` (parametrized license matrix).
- Run `pnpm curriculum:smoke` against a disposable Postgres for the end-to-end walk; the
  contract also keeps `pnpm db:smoke` redacted and stable.
- See `docs/adr/B1-04-curriculum-catalog.md` for the immutable-version model, public-read
  rationale, ETag strategy, and the deferred items (school-level overrides, public-school
  directory projection, CMS-side visual maps, worker-driven publish, object-storage of
  curriculum assets).

## Notification spike (B0-09)

D-007 transactional notification provider spike. The memory-backed `NotificationAdapter` and
`notification_outbox` table are wired behind a stable boundary so a real provider
(SendGrid / Twilio / AWS SES / Resend / etc.) can drop in later without touching
auth/curriculum modules.

- Migration `src/infrastructure/database/migrations/0005_notification_outbox.sql` adds
  `notification_templates`, `notification_outbox`, and `notification_send_audit`. It also seeds
  two templates (`auth.recovery`, `workspace.invite`) in both `id-ID` and `en-US`.
- Locale strategy: `id-ID` is the default and the fallback when the requested locale is missing.
- Dedupe boundary: `(template_key, recipient_hash, payload_hash)` partial unique index on
  `status = 'sent'`. `eventId` is **not** part of the dedupe key.
- The dispatcher runs the `eventId` insert, template lookup, adapter send, and audit insert in
  one `db.transaction` so a caller-side rollback leaves no rows behind.
- PII: the recipient string and rendered body **never** appear in logs or the audit row.
- Async drain worker (B2-N) is deferred. The spike synchronously dispatches.

HTTP surface (read-only + stub bearer on dispatch — B1-03 will tighten):

| Method | Path                                       |
| ------ | ------------------------------------------ |
| `GET`  | `/v1/notifications/templates`              |
| `GET`  | `/v1/notifications/templates/:templateKey` |
| `POST` | `/v1/notifications/dispatch`               |
| `GET`  | `/v1/notifications/audit`                  |

Smokes (disposable Postgres at `127.0.0.1:55443`):

```bash
DATABASE_URL=postgres://lembar@127.0.0.1:55443/lembar DATABASE_REQUIRED=true pnpm notification:smoke
DATABASE_URL=postgres://lembar@127.0.0.1:55443/lembar DATABASE_REQUIRED=true pnpm notification:smoke:duplicate
```

See `docs/adr/B0-09-notification-provider.md` for the decision, locale strategy, dedupe
boundary, and deferred items.

## Product AI adapter spike (B0-08)

D-019 candidate evidence: a provider-neutral `ProductAiAdapter` boundary with mock-first
coverage and an opt-in `openai` driver. The spike routes every outcome through the
established B0-09-style redacted audit pattern (`prompt_fingerprint` /
`response_fingerprint` only, no raw prompt or response body) and caps schema-repair
attempts via `AI_SCHEMA_REPAIR_MAX`. No HTTP surface is added by the spike.

- Migration `src/infrastructure/database/migrations/0008_product_ai_audit.sql` adds
  `ai_jobs_audit` (additive only). `pnpm db:check` validates the journal.
- Driver defaults to `mock`; the live `openai` driver only fires when `AI_DRIVER=openai`
  is set AND a non-empty `OPENAI_API_KEY` is present in the runtime environment. The
  spike deliberately refuses to read a real key from `.env.example`.
- Queue integration is provided by the existing accepted B0-06 seam — this spike owns
  the adapter, the env parser, the audit row, and the smoke script. Worker integration
  belongs to B2-N.
- Test coverage at `test/infrastructure/ai/*` proves: mock determinism across N calls,
  structured success + repair cap + `SCHEMA_VALIDATION_FAILED`, rate-limit / refusal
  envelope mapping, no real provider call when `AI_DRIVER=mock`, and prompt/response
  redaction in audit rows.

Run:

```bash
pnpm ai:smoke
```

Output is a single redacted JSON envelope covering privacy (`promptFingerprint`,
`promptByteLength`, leak checks), latency (`mockLatencyFloorMs`), schema-repair attempts,
mock-vs-live adapter instantiation, and audit row counts.

See `docs/adr/B0-08-product-ai-provider.md` for the D-019 candidate recommendation,
privacy review, structured-output reliability, latency + cost model, and rollback plan.

## Spike configuration

```bash
DATABASE_URL=postgres://...         # required when DATABASE_REQUIRED=true
DATABASE_POOL_MAX=10                # default: 10
DATABASE_SSL_MODE=disable|require   # default: disable
DATABASE_REQUIRED=false             # default: false
STORAGE_DRIVER=memory|local         # default: memory
STORAGE_LOCAL_ROOT=/tmp/lembar      # required when STORAGE_DRIVER=local
PDF_RENDERER=stub|playwright        # default: stub; playwright throws by design
PDF_RENDERER_DRIVER=stub|playwright # compatibility alias
```

## Security notes for the spike

- Database DSNs are treated as secrets and are never logged.
- Signed URLs are treated as secrets and are never logged.
- Storage keys are treated as secrets and are never logged.
- Smoke scripts and tests only log redacted fingerprints and deterministic hashes.
- Stub PDF output is deterministic bytes for fixture verification, not a real user-facing PDF.

## Repository layout

```text
src/
  bootstrap/       # api.ts, worker.ts, app.ts
  common/          # shared utilities (redaction, error envelope, request ids)
  config/          # per-process typed env parsing
  infrastructure/
    database/      # Drizzle schema, migrations, db factory (B0-04)
    storage/       # StorageAdapter + local/memory drivers
    pdf/           # RenderAdapter + stub/disabled-playwright drivers
  smoke/           # executable smoke entrypoints
  modules/         # domain modules — populated by later tasks
contracts/         # OpenAPI artifacts — populated by later tasks
test/              # unit + smoke
```

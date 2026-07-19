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

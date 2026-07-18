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

Strict production mode is opt-in via `APP_ENV=production`. Secrets (DB URLs, auth
signing keys, AI/storage/payment keys, webhook secrets) are not configured here —
they are added per process by later tasks and must never be committed.

## Repository layout

```text
src/
  bootstrap/   # api.ts, worker.ts, app.ts
  modules/     # domain modules — populated by later tasks
  infrastructure/
  common/
contracts/     # OpenAPI artifacts — populated by later tasks
test/          # unit + smoke
```

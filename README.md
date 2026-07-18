# Backend-Lembar

Modular monolith for `lembar` (API + worker) — see `AGENTS.md`,
`docs/backend/README.md`, and `docs/backend/BACKEND-ARCHITECTURE.md`.

## B0-02 baseline (additive over B0-01)

- Per-process typed env schemas: `src/config/base.env.ts`, `api.env.ts`, `worker.env.ts`.
- `parseBaseEnv` / `parseApiEnv` / `parseWorkerEnv` validate once at bootstrap and return
  typed objects; unknown enum values or out-of-range numbers throw `ConfigError`.
- Redaction: errors list key names and reasons only — values are never logged or surfaced.
- Strict production mode: `APP_ENV=production` requires `PUBLIC_APP_URL`; no production secret
  is required for local install/typecheck/unit.
- `bootstrap/api.ts` and `bootstrap/worker.ts` consume the parsers (no silent fallback).
- Vitest coverage for defaults, invalid port, missing required key, wildcard CORS, and
  redaction (`test/config/*.test.ts`).

## Scripts

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
node dist/bootstrap/api.js          # API on :4000
node dist/bootstrap/worker.js       # one heartbeat, exit 0
```

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

```
src/
  bootstrap/   # api.ts, worker.ts, app.ts
  modules/     # domain modules — populated by later tasks
  infrastructure/
  common/
contracts/     # OpenAPI artifacts — populated by later tasks
test/          # unit + smoke
```

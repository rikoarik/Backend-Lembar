# Backend-Lembar

Modular monolith for `lembar` (API + worker) — see `AGENTS.md`,
`docs/backend/README.md`, and `docs/backend/BACKEND-ARCHITECTURE.md`.

## Current baseline

- One pnpm package, Node 22 LTS pin (`.nvmrc`, `engines`).
- Direct Fastify API entrypoint with `GET /health` on port `4000`.
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
pnpm storage:smoke
pnpm pdf:smoke
node dist/bootstrap/api.js          # API on :4000
node dist/bootstrap/worker.js       # one heartbeat, exit 0
```

## Spike configuration

```bash
STORAGE_DRIVER=memory|local         # default: memory
STORAGE_LOCAL_ROOT=/tmp/lembar      # required when STORAGE_DRIVER=local
PDF_RENDERER_DRIVER=stub|playwright # default: stub; playwright throws by design
```

## Security notes for the spike

- Signed URLs are treated as secrets and are never logged.
- Storage keys are treated as secrets and are never logged.
- Smoke scripts and tests only log redacted fingerprints and deterministic hashes.
- Stub PDF output is deterministic bytes for fixture verification, not a real user-facing PDF.

## Repository layout

```text
src/
  bootstrap/       # api.ts, worker.ts, app.ts
  common/          # shared utilities (redaction)
  infrastructure/
    storage/       # StorageAdapter + local/memory drivers
    pdf/           # RenderAdapter + stub/disabled-playwright drivers
    smoke/         # executable smoke entrypoints
  modules/         # domain modules — populated by later tasks
contracts/         # OpenAPI artifacts — populated by later tasks
test/              # unit + smoke
```

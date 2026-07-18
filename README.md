# Backend-Lembar

Modular monolith for `lembar` (API + worker) — see `AGENTS.md`,
`docs/backend/README.md`, and `docs/backend/BACKEND-ARCHITECTURE.md`.

## B0-01 baseline

- One pnpm package, Node 22 LTS pin (`.nvmrc`, `engines`).
- Direct Fastify API entrypoint with `GET /health` on port `4000`.
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
node dist/bootstrap/api.js          # API on :4000
node dist/bootstrap/worker.js       # one heartbeat, exit 0
```

## Configuration

`.env.example` lists non-secret defaults. Real per-process env schemas are
introduced per entrypoint in later tasks (`api.env.ts` / `worker.env.ts`).
Do not commit secrets.

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

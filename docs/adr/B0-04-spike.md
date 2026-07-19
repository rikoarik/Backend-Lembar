# B0-04 — PostgreSQL + Drizzle spike

Status: READY_FOR_OWNER_REVIEW (B0-04 spike)

## Scope delivered

- Accepted ORM baseline: Drizzle ORM (`drizzle-orm` ^0.45.2, `drizzle-kit` ^0.31.10) over
  node-postgres (`pg` ^8.22.0, `@types/pg` ^8.20.0). Resolves owner decision D-003.
- Typed env schema `src/config/database.env.ts` with `DATABASE_URL`, `DATABASE_POOL_MAX`,
  `DATABASE_SSL_MODE`, `DATABASE_REQUIRED`. Same `ConfigError` redaction discipline as
  B0-02.
- `src/infrastructure/database/schema.ts` with three spike tables only: `tenants`,
  `users`, `schools`. Inferred row types exported as `Tenant`, `User`, `School`.
- Migration `src/infrastructure/database/migrations/0001_init.sql` + Drizzle journal
  under `meta/_journal.json`. Migration applies via `migrate()` programmatically.
- `drizzle.config.ts` (dialect postgresql, schema `./src/infrastructure/database/schema.ts`,
  out `./src/infrastructure/database/migrations`).
- `src/infrastructure/database/db.ts` with `createDatabase({ connectionString, poolMax?,
  ssl? })`, `getPool`, `closeDatabase`, and `healthcheck()` that returns a redacted
  `{ ok, latencyMs, error? }` (no DSN leakage).
- `src/smoke/database.ts` CLI: parses env, creates pool, runs migrations in a single
  transaction (tenant + user + school), reads back, asserts tenant isolation, prints a
  redacted JSON summary, exits `0`/`1`.
- `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:push`, `pnpm db:check`, `pnpm db:smoke`.
- `test/infrastructure/database.test.ts` runs real DB roundtrip only when `DATABASE_URL`
  is set; otherwise skips clearly with `DB smoke skipped without DATABASE_URL`.
- `.env.example` documents all four env keys. `pnpm-workspace.yaml` uses the
  pnpm 11 `onlyBuiltDependencies` schema with `esbuild` and `drizzle-kit`.

## Explicitly not delivered

- No business schema (workspace, curriculum, sources, assessment, generation, jobs,
  output, library, commerce, operations, marketing CMS). Owners are added later.
- No RLS policies, no production-grade migrations tooling wrapper, no seeders.
- No Docker/testcontainers path: this environment has no Docker. The local PG path
  is `127.0.0.1:5432` and is documented as disposable/dev only.
- No change to `contracts/openapi*.yaml` or `docs/backend/BACKEND-ARCHITECTURE.md`.

## Env keys

- `DATABASE_URL` — DSN; optional locally, required when `DATABASE_REQUIRED=true`.
- `DATABASE_POOL_MAX` — integer `1..50`, default `10`.
- `DATABASE_SSL_MODE` — `disable|require`, default `disable`.
- `DATABASE_REQUIRED` — `true|false|1|0`, default `false`.

## db:smoke usage

```bash
# local disposable Postgres on 127.0.0.1:5432
createdb lembar
DATABASE_URL=postgres://lembar:lembar@127.0.0.1:5432/lembar pnpm db:smoke
```

The command `pnpm build && node dist/smoke/database.js` is the runtime evidence
surface; it exits `1` on any failure with a redacted error envelope.

## Deferred items

- Real per-module migrations and aggregation indexes.
- RLS or app-side tenant filter (see open question).
- Idempotency/serializable-retry policies for migrations under contention.
- Operator runbook for production Postgres (backup, role separation, observability).

## Owner-open questions

1. Postgres-only runtime is acceptable for production, or do we keep a managed-SQL escape
   hatch for read replicas? The current architecture hard-codes PostgreSQL.
2. Tenant isolation strategy: enable PostgreSQL RLS as defense-in-depth now, or wait for
   the proven integration pattern that `BACKEND-ARCHITECTURE.md` calls out before
   layering it on top of app-side tenant filtering?

## Evidence

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm test` —
  captured in handoff.
- `pnpm db:smoke` against local disposable Postgres on `127.0.0.1:5432` — captured in
  handoff.

# CI Quality Gate — Backend-Lembar

Status: active. Owner: lembar-devops. Task: t_2e396f27.

## What runs

`pnpm gate` (`scripts/quality-gate.sh`) runs the AGENTS.md "Quality gates" sequence in
order, fail-fast:

| # | Step | Command |
|---|------|---------|
| 1 | install | `pnpm install --frozen-lockfile` |
| 2 | typecheck | `pnpm typecheck` |
| 3 | lint | `pnpm lint` |
| 4 | format | `pnpm format:check` |
| 5 | unit | `pnpm test` (builds first) |
| 6 | postgres integration | `pnpm test:db` |
| 7 | openapi | `pnpm openapi:validate && pnpm openapi:breaking` |
| 8 | secret scan | `pnpm secret:scan` |

`GATE_CONTINUE_ON_FAIL=1` runs every step instead of stopping at the first failure, for
triaging a tree with several problems at once.

## Where it runs

- `.github/workflows/deploy-backend.yml`, job `gate` — on push to `dev`. Job `deploy` declares
  `needs: gate`, so **a failing step blocks the production deploy**. The gate lives in this
  workflow rather than a separate one because GitHub Actions `needs:` does not cross workflow
  files; a parallel workflow could finish after the deploy had already shipped.
- `.github/workflows/quality-gate.yml` — on every pull request and on pushes to branches other
  than `dev`. Same `pnpm gate`. `dev` is excluded to avoid duplicating a heavy job on the single
  self-hosted runner.

## `test:db` decision

`pnpm test:db` runs **in CI** — it is step 6 of `pnpm gate`, not documented as out-of-CI. It
starts the ephemeral Postgres from `compose.test.yaml` on `127.0.0.1:55432`, runs
`scripts/prepare-test-db.mjs`, then vitest with `DATABASE_REQUIRED=true`.

Runner requirement: the self-hosted runner needs `docker`, `pnpm` and Node 22 on PATH. If
docker is missing, `test:db` fails and the deploy is blocked — the intended fail-closed
direction.

## Secret scan

`pnpm secret:scan` (`scripts/secret-scan.mjs`) scans the git-tracked tree only, so
`node_modules/`, `dist/` and ignored `.env` files are out of scope by construction. Output never
prints a value — only path, line, rule id and a redacted preview (2 characters + length).

Two layers: shape rules (private-key blocks, `AKIA…`, `ghp_…`, `xox…`, `AIza…`, `sk-…`,
`sk-ant-…`, JWT triples, connection URLs with an inline password) and a key-driven rule
(quoted literal assigned to a credential-shaped name such as `apiKey`, `jwtSecret`,
`OPENAI_API_KEY`).

A generic Shannon-entropy sweep over every quoted literal was implemented and **rejected**: on
this tree it fired ~580 times, all on identifiers, error codes (`SCHEMA_VALIDATION_FAILED`),
UUIDs, YAML `$ref` pointers and absolute paths. A gate that noisy gets disabled or
blanket-allowlisted, which is worse than no gate. Do not re-add a bare entropy sweep; add a
shape or key-name rule instead.

Suppressions live in `scripts/secret-scan.allow`, one `path:rule-id  reason` line each; the
scanner exits 2 if a reason is missing. Currently zero entries. Never delete or loosen a rule to
make the gate pass — fix the leak or add a reasoned allowlist entry.

## Baseline at the time of introduction

The gate is introduced against a **red** dev tip (`3f8dbe0`), which is the defect this task
addresses: nothing was gating the deploy. Measured on that revision:

| Step | Result |
|------|--------|
| install | PASS |
| typecheck | PASS |
| lint | FAIL — 260 problems (258 errors) |
| format:check | FAIL — 168 files |
| test | FAIL — 1 failed (`test/plan-catalog.test.ts`, `priceAmount` 49000 → 149000) |
| test:db | FAIL — 9 failed |
| openapi:validate | PASS |
| openapi:breaking | FAIL — baseline drift |
| secret:scan | PASS |

Consequence: until the lint/format/test/test:db/openapi-breaking fixes land (tracked as
t_e901a838, t_d28d1ef8, t_ee5e0760), pushes to `dev` will show a red `gate` job and the deploy
job will be skipped. That is the correct behaviour for a red tree, and it is the point of the
task: previously that same red tree auto-deployed to production.

## Rollback

Revert the commit: delete `scripts/quality-gate.sh`, `scripts/secret-scan.mjs`,
`scripts/secret-scan.allow`, `.github/workflows/quality-gate.yml`, drop the `secret:scan` and
`gate` scripts from `package.json`, and restore `deploy-backend.yml` to the single-job form.
No data, schema or runtime state is involved; the change is CI-configuration only.

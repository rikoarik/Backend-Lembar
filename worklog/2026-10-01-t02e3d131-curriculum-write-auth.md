# 2026-10-01 — kanban t_02e3d131: curriculum write bearer fails closed

**Task:** `t_02e3d131` (assignee `lembar-backend`, parent `t_4790fef9` AUDIT-2) —
"Curriculum write endpoints accept any Bearer token — CURRICULUM_WRITE_TOKEN
empty in live .env".

**Branch:** `p_270d5536/t_02e3d131-be-sec-curriculum-write-endpoints-accept`
(worktree `.worktrees/t_02e3d131`, base `origin/dev` @ `3f8dbe0`).

**Not deployed.**

## The defect (AUDIT-2, live 2026-10-01)

`bearerActor()` in `src/modules/curriculum/adapters/http/schema.ts` read:

```ts
const allowed = token.length > 0 && (expected === null || token === expected);
```

`parseCurriculumEnv` maps an empty/absent `CURRICULUM_WRITE_TOKEN` to `null`.
With the deployed `CURRICULUM_WRITE_TOKEN=` (empty), `expected === null`, so
`allowed` reduced to `token.length > 0` — **any** non-empty Bearer token was
accepted. Live proof recorded on the card: `Bearer junk` → 201 on
`POST /v1/curriculum/curricula` (row committed) and 200 on
`…/source-rights-gate`; no header → 401. The same token also selected the
actor recorded on publish. The identical pattern existed in
`src/modules/notifications/adapters/http/routes.ts` `requireBearer()`.

## Decision (DoD 1) — fail closed (option a)

Chosen: **(a) fail closed.** `bearerActor` rejects whenever the configured
token is unset/empty, and mounting the curriculum module under
`APP_ENV=production` without a token is a boot-time `ConfigError`.

Justification, over option (b) "remove the write surface from the API process":
the curriculum write endpoints are part of the accepted B1-04 catalog surface
and are exercised by `pnpm curriculum:smoke` and the contract/OpenAPI artifacts;
removing them from the API process is a product/scope change (it deletes
documented endpoints) and is not this card's mandate. Failing closed is a pure
security fix: it changes nothing about which endpoints exist, only that an
unconfigured credential denies instead of admits. The boot guard gives the
production operator a loud, actionable failure (key name only, never a value)
instead of a silently open write API, while local/test keep a clean 401 so no
production secret is required for build/unit tests (ENVIRONMENT-MATRIX.md:55,
BACKEND-ARCHITECTURE.md:181).

## Changed

- `src/common/auth/stubBearer.ts` (new): `bearerTokenFrom()` (extracts only a
  well-formed `Bearer` credential) and `stubBearerAllowed()` — constant-time,
  and denies when **either** side is missing/empty. Shared by both stub-bearer
  seams so the class of bug is fixed once, not per call site.
- `src/modules/curriculum/adapters/http/schema.ts`: `bearerActor()` now uses
  `stubBearerAllowed(expected, token)`; unset ⇒ 401.
- `src/modules/notifications/adapters/http/routes.ts`: `requireBearer()` uses
  the same helper; the duplicated inline check is gone.
- `src/config/curriculum.env.ts`: `assertCurriculumWriteTokenConfigured()` —
  `APP_ENV=production` + no token ⇒ `ConfigError` naming `CURRICULUM_WRITE_TOKEN`
  only.
- `src/bootstrap/app.ts`: call the boot guard before `registerCurriculumRoutes`.
- `.env.example`: documents the variable's scope and **SECRET** classification,
  the fail-closed semantics, and that empty is local/test-only.
- `src/smoke/curriculum.ts`: configures a non-secret stub token before
  `buildApp()` and adds a `write-rejects-forged-bearer` step (401 for
  `Bearer junk`).
- `test/modules/curriculum/write-auth.test.ts` (new, 11 tests).

## Contract impact

None. No path, method, schema or response shape changed; the only behavioral
change is that a forged/absent credential now yields `401 AUTH_REQUIRED`
(already a documented error code) instead of being accepted. OpenAPI unchanged,
baseline untouched.

## Evidence

- Unit (green): `npx vitest run test/modules/curriculum/write-auth.test.ts` →
  `Test Files 1 passed (1)`, `Tests 11 passed (11)`.
- Genuinely RED against the old guard: reverted only `bearerActor()` to the
  pre-fix expression and re-ran the same file →
  `Tests 2 failed | 9 passed (11)`, failure at the audit repro
  `expected 200 to be 401` for `Bearer junk` with `CURRICULUM_WRITE_TOKEN=''`.
  Fix restored afterwards.
- `npx vitest run test/modules/curriculum test/modules/notifications` →
  `4 passed | 2 skipped`, `24 passed | 15 skipped`.
- `npx tsc -p tsconfig.json --noEmit` → exit 0; `npx tsc -p tsconfig.build.json`
  → exit 0.
- `npx eslint` on the seven changed source/test files → no new errors (the four
  `no-unused-vars` in `app.ts` at lines 18/98/125/126 are pre-existing, outside
  this diff, and part of the repo-wide 258-error red tracked by `t_e901a838`).
- `npx prettier --check` on all changed code files → "All matched files use
  Prettier code style".

Live before/after curl matrix (DoD 4) is deferred: this card is `Do not deploy`,
so "after" requires the deploy that the card forbids. The "before" matrix is the
audit's, reproduced in the card comment; the same repro is locked as a unit test
(`Bearer junk` ⇒ 401) that goes green only with this fix.

## Known limitations

- This is still a shared static stub bearer, not the B1-03 permission layer;
  real per-actor authorization remains future work. The fix closes the specific
  "unset means accept anything" hole and makes an unconfigured production mount
  fail loudly.
- The live `after` evidence must be captured by whoever deploys this branch.

STOP.

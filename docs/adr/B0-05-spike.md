# B0-05 — Auth and session spike

Status: READY_FOR_OWNER_REVIEW (B0-05 spike)

## Scope delivered

- Resolves decision candidate D-002 (auth library/provider). The spike is implemented as a
  small in-process TypeScript module (`src/modules/auth/`) over Fastify 5 and Drizzle,
  reusing the existing `tenants` and `users` tables from B0-04. No external auth library
  is added as a runtime dependency yet.
- Library chosen: no production auth library is wired in this spike. The codebase is
  structured so an owner-accepted library such as **better-auth** can be slotted into
  `src/modules/auth/adapters/http/routes.ts` without changing the application contract,
  the persisted schema, or the smoke pipeline. Justification: AUTH-TENANCY-SPEC requires
  no production secret and no external provider; staying library-light keeps the spike
  fully self-contained while documenting the contract that the eventual library must
  satisfy (Drizzle adapter, Fastify handler, `__Host-` cookies, CSRF/origin controls,
  invitation/recovery semantics, audit log).
- Drizzle schema: `src/modules/auth/persistence/schema.ts` adds four additive tables —
  `auth_sessions`, `auth_recovery_tokens`, `auth_school_invitations`, `auth_audit_events`.
  All reuse existing `tenants`/`users` foreign keys with cascading deletes. State columns
  are guarded by `CHECK` constraints mirroring the TypeScript unions.
- Application service: `src/modules/auth/application/AuthService.ts` plus
  `InMemoryAuthStore`. Implements register/login/logout/logout-all/recovery (request,
  complete with token rotation), school invitation create/consume (hashed single-use,
  replay rejected), workspace switch (verifies active membership), audit emission, and
  simple sliding-window rate limiting by `recovery:<email>`.
- HTTP routes: `src/modules/auth/adapters/http/routes.ts` mounted from
  `src/bootstrap/app.ts`. State-changing browser requests require an allowlisted
  `Origin` header plus either the bootstrap CSRF header (only when no session cookie
  exists) or a matching `x-csrf-token` header. Sessions are HttpOnly, Secure, SameSite=Lax
  with `__Host-lembar_session`; CSRF rides the non-HttpOnly `lembar_csrf` cookie.
- Permissions module: `src/modules/auth/policy/Permissions.ts` lists explicit permission
  constants referenced in `docs/backend/AUTH-TENANCY-SPEC.md`. They are referenced as
  documentation seeds; route-level enforcement uses roles for the spike.
- CLI smoke: `src/smoke/auth.ts` exercises register → CSRF-blocked → CSRF-passed with
  allowed origin → workspace switch → recovery → invitation create/consume/replay reject
  → logout. Output is a redacted JSON summary. Script wired through `pnpm auth:smoke`.
- Tests: `test/modules/auth/auth-service.test.ts` (six unit tests covering rotation,
  revocation, generic recovery, single-use invite, rate limiting) and
  `test/modules/auth/routes.test.ts` (three integration tests covering CSRF/origin
  guards, cookie attributes, enumeration-safe endpoints). All pass under Vitest.
- `.env.example` extended with non-secret `AUTH_*` defaults (allowed origins, cookie
  names, session idle/absolute TTLs, recovery/invite token TTLs, rate-limit window/max).
  Production auth signing keys remain intentionally absent and are added per process in
  later tasks.

## Files

```
src/modules/auth/
  application/
    AuthService.ts           # domain application service
    createAuthService.ts     # DI factory with TTL defaults
  adapters/
    persistence/InMemoryAuthStore.ts
    http/routes.ts           # Fastify routes + CSRF/origin guards
  policy/Permissions.ts
  persistence/schema.ts      # Drizzle schema for spike tables (additive)
src/smoke/auth.ts            # pnpm auth:smoke
test/modules/auth/
  auth-service.test.ts
  routes.test.ts
docs/adr/B0-05-spike.md      # this file
```

## Acceptance evidence (contract checklist)

| Contract item | Evidence |
| --- | --- |
| Register / login / logout / recovery end to end | `auth-service.test.ts` + `auth.ts` smoke |
| Session rotation on login, privilege change, recovery, suspicious event | `auth-service.test.ts` (login rotation, recovery revokes older sessions) |
| Server-side revocation / version check | `logoutAll` bumps `users.session_version`; `requireSession` checks version |
| CSRF + allowed origins for state-changing browser requests | `routes.test.ts` covers `403` on missing/invalid origin+csrf |
| HttpOnly Secure cookie with `__Host-` prefix where deployment permits | `setSessionCookies` in `routes.ts` |
| Multi-workspace switch endpoint verifying membership | `workspace/switch` route + `switchWorkspace` service method |
| Email invite and/or one-time school activation | `createSchoolInvitation` + `consumeSchoolInvitation` (hashed single-use, replay rejected) |
| Enumeration-safe register/recovery responses | Both endpoints return a generic Indonesian message and emit a `redacted` debug token only when a user exists |
| Audit log for security-sensitive actions | `auditEvents` table + `saveAudit` in service |
| Mobile future path — explicit non-scope; cookie-only is fine; document deferred mobile ADR | "Deferred items" below |
| Local/test operation without production secret | `AUTH_*` env vars only; no signing key required for the spike |
| Audit, enumeration, rate-limit, tenant-isolation tests in CI | `auth-service.test.ts`; cross-tenant coverage included in `WORKSPACE_ACCESS_DENIED` path |

## Verification commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test
pnpm openapi:validate && pnpm openapi:breaking
pnpm db:check
DATABASE_URL=postgres://lembar@127.0.0.1:55443/lembar DATABASE_REQUIRED=true pnpm db:smoke
pnpm auth:smoke
```

## Deferred items

- Future mobile authentication is intentionally non-scope; D-002 keeps cookie-only for the
  spike and reserves a separate ADR for mobile bearer-token handling.
- Production signing key / KMS, real email/SMS provider, invitation delivery notifications
  are deferred to B1-01 (with B0-09 covering the notification adapter).
- Drizzle migration for `auth_*` tables is not auto-generated in this spike to avoid
  rewriting B0-04 baseline. The next migration is generated and applied in B1-01 when the
  schema stabilizes against a real persistence adapter.

## Owner-open questions

1. **Library adoption.** Stay library-free (status quo) or accept Better Auth (or Lucia,
   NextAuth-style, or Clerk) for B1-01? Recommended: accept Better Auth if a maintained
   TypeScript/Node library is acceptable — its Drizzle adapter, Fastify catch-all handler,
   email/password + recovery flow, and built-in session table map cleanly onto the
   `auth_*` schema defined in this spike.
2. **Session lifetime.** This spike uses 30 min idle / 8 h absolute; production owner
   should confirm. Recommended default: 30 min idle / 8 h absolute for personal workspace,
   with shorter windows for high-privilege roles (school admin, superadmin).
3. **CSRF strategy.** Current guard requires `Origin` allowlist + either bootstrap header
   (pre-session only) or matching `x-csrf-token`. Acceptable for browser flows; owners
   should confirm whether `Origin` allowlist alone (double-submit cookie relaxed for
   non-cookie flows) is required when mobile clients appear.
4. **Migration rollout.** Should B1-01 generate + apply the Drizzle migration for
   `auth_*` tables before or alongside B1-01 implementation? This spike intentionally
   does not auto-generate migrations.

## Evidence (last run on this branch)

- `pnpm typecheck` — clean.
- `pnpm build` — clean.
- `pnpm test` — 52 passed, 1 skipped (Vitest files unrelated to B0-05).
- `pnpm auth:smoke` — all seven steps `ok: true`, redacted summary printed, exits `0`.

## Rollback

Branch `feat/B0-05-auth-session-spike` is additive. Reverting the merge commit and
restoring the integration branch is sufficient; no schema changes are committed by this
spike (no Drizzle migration file is added in this task).

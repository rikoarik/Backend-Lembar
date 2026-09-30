# 2026-09-30 — BUG-18/21/22 (kanban t_2cd6cd63): route auth hilang

**Task:** `t_2cd6cd63` ([P1], assignee `lembar-backend`) — FE-AUD-01-2026-09-30
BUG-18, BUG-19, BUG-21, BUG-22.

**Repo:** `Backend-Lembar` @ `dev`. Branch kerja: `wt/t_2cd6cd63`, di-base dari
`origin/dev` `91291d4`.

## Gejala (repro sebelum fix, ke runtime live)

```
POST /v1/auth/logout              -> 404 RESOURCE_NOT_FOUND
POST /v1/auth/recovery/request    -> 404 RESOURCE_NOT_FOUND
POST /v1/auth/workspace/switch    -> 404 RESOURCE_NOT_FOUND
GET  /v1/auth/invitations/preview -> 404 RESOURCE_NOT_FOUND
POST /v1/auth/invitations/consume -> 404 RESOURCE_NOT_FOUND
```

`src/bootstrap/app.ts` menonaktifkan `registerAuthRoutes` (keluarga session-cookie),
sehingga seluruh family route auth lama hilang dan tidak muncul di `/docs/json`.

## Akar masalah

1. **Route tidak pernah didaftarkan.** `registerAuthRoutes` dimatikan ("Session-based
   auth disabled — using JWT auth only") tanpa menyediakan padanan JWT-nya. FE/BFF
   sudah memanggil path-path itu, jadi semuanya 404.
2. **Logout tidak punya efek server-side.** JWT stateless berumur 7 hari; menghapus
   cookie di client meninggalkan token yang masih valid 200 di `GET /v1/me`.
3. **`throwApiError('password_policy', …)` tidak ada di `codeMap`.** Jatuh ke default
   `INTERNAL_ERROR`, jadi password lemah menjawab **500 `retryable:true`** alih-alih
   **400 `VALIDATION_FAILED`**. Ini bukan cuma di route baru — `POST /v1/auth/register`
   di produksi juga 500 untuk password lemah. (Ditemukan task `t_9d83cd2a`, tiket
   `t_c3e6a292`; diperbaiki di sini karena menyentuh jalur yang sama.)

## Keputusan kontrak — KONTRAK RESMI undangan

`POST /v1/invitations` (buat) lalu:

| Langkah | Endpoint resmi | Auth |
|---|---|---|
| Preview | **`GET /v1/auth/invitations/preview?token=<raw>`** | publik |
| Accept | **`POST /v1/auth/invitations/consume`** body `{token, password}` | publik |

Ini yang sudah dipanggil FE BFF (`app/v1/auth/invitations/[token]/route.ts` →
`/v1/auth/invitations/preview`, dan `.../[token]/accept/route.ts` →
`/v1/auth/invitations/consume`), jadi **FE tidak perlu diubah**.

Jalur `GET /v1/invitations/preview` + `POST /v1/invitations/accept` (modul school,
task `t_9d83cd2a`) tetap ada dan tetap sah untuk klien yang mengirim password di
jalur school. Untuk alur undangan dari halaman aktivasi, yang resmi adalah dua
endpoint `/v1/auth/invitations/*` di atas.

Catatan penting: `POST /v1/invitations/accept` menuntut JWT, sementara pengundang
baru belum punya akun — itulah sebabnya `/v1/auth/invitations/consume` dibuat
publik dan jadi kontrak untuk accept.

## Patch

- `src/modules/auth/adapters/http/jwtAuthFlowRoutes.ts` (baru) — registrasi route
  JWT-mode: `POST /v1/auth/logout`, `POST /v1/auth/recovery/request`,
  `POST /v1/auth/recovery/complete`, `POST /v1/auth/workspace/switch`,
  `GET /v1/auth/invitations/preview`, `POST /v1/auth/invitations/consume`.
  Additive — tidak menggantikan route yang sudah ada.
- `src/modules/auth/application/JwtAuthFlows.ts` (baru) — `AuthRecoveryService`
  (revoke sesi, recovery netral, switch workspace) dan `InvitationService`
  (lookup/preview/consume, one-time, transaksional).
- `src/modules/auth/infrastructure/jwtMultiRole.ts` — klaim `sv` (session version)
  di token; token lama tanpa `sv` dibaca sebagai 1 (`DEFAULT_SESSION_VERSION`) supaya
  deploy tidak memaksa semua orang login ulang.
- `src/modules/auth/persistence/jwtUsersSchema.ts` + migrasi
  `0045_jwt_users_session_version.sql` — kolom `jwt_users.session_version`
  (`integer NOT NULL DEFAULT 1`, idempoten `ADD COLUMN IF NOT EXISTS`).
- `src/modules/auth/application/JwtMultiRoleAuthService.ts` — `toAuthResponse`
  menandatangani token dengan `sv: user.sessionVersion`; kebijakan password memakai
  helper tunggal.
- `src/common/middleware/jwtMultiRoleAuth.ts`, `authenticateWithDb.ts`,
  `authenticate.ts` — tolak token yang `sv`-nya tidak lagi sama dengan
  `jwt_users.session_version`. **Dijaga**: pemeriksaan hanya dijalankan bila kolom
  benar-benar terbaca, supaya baris tanpa kolom itu tidak mengubah setiap request
  terautentikasi jadi 401.
- `src/common/errors/apiError.ts` — `password_policy: 'VALIDATION_FAILED'`.
- `src/bootstrap/app.ts` — panggil `registerJwtAuthFlowRoutes` setelah
  `registerPasswordResetRoutes`; `registerAuthRoutes` tetap dinonaktifkan.
- `src/modules/admin/adapters/http/adminRoutes.ts`,
  `src/modules/auth/adapters/http/googleOAuthRoutes.ts`,
  `src/modules/auth/application/PasswordResetService.ts` — jalur minting token lain
  ikut membawa `sv`, supaya token dari impersonasi superadmin dan login Google juga
  bisa di-revoke oleh logout.

`/v1/auth/reset-password` **tidak disentuh**.

## Verifikasi live

Runtime: build dari worktree ini (`tsc -p tsconfig.build.json` exit 0) di
`127.0.0.1:4996` dengan `DATABASE_URL` live. Harness:
`probe_auth_routes.py` (13 kasus) dan `probe_invitation_e2e.py` (12 kasus, menulis
dan membersihkan barisnya sendiri di DB).

```
probe_auth_routes.py  -> 13/13 PASS
  register                        201
  me-before-logout                200
  logout                          200
  me-after-logout-must-401        401  req_udsjJTkcIpvdjCT6   <- inti BUG-21
  login-after-logout              200
  recovery-known-email            202  (pesan netral)
  recovery-unknown-email          202  (pesan identik)
  workspace-switch-foreign-ws     403  req_N7LNo8VXXmSNdSGp  WORKSPACE_ACCESS_DENIED
  workspace-switch-no-token       401  req_WLqbJORFjiFolIe8
  workspace-switch-own-ws         200  token=yes
  invitation-preview-bogus        200  status=invalid
  invitation-consume-bogus        404  req_XavnVCHqZTTHHvfi
  invitation-consume-no-password  400  req_4o9FtlQsjHPELEYm

probe_invitation_e2e.py -> 12/12 PASS
  preview-pending                 200  status=pending
  consume-weak-password           400  req_P81aqiIzcA6--UkE
  consume-valid                   200  userId=51116ffd
  consume-replay-must-fail        404  req_kJTnXdSM6wawISAr
  preview-after-consume           200  status=revoked
  invitee-login                   200
  preview-expired                 200  status=expired
  consume-expired                 410  req_zUtstqmROiHd8KHQ
  recovery-request                202
  reset-password                  200
  login-new-password              200
  recovery-complete-replayed-token 400 req_IvVLJCYCnVp1XAze
```

`POST /v1/auth/register` password lemah: **500 → 400** (`VALIDATION_FAILED`,
`retryable:false`) setelah `password_policy` masuk `codeMap`.

## Gate

- `tsc -p tsconfig.json --noEmit` → exit 0
- `tsc -p tsconfig.build.json` → exit 0
- `vitest run` (full, `--no-file-parallelism`) dibandingkan 1:1 dengan baseline
  `origin/dev` `91291d4` di worktree terpisah:
  - baseline: 2 file / 2 test gagal
  - branch ini: 1 file / 1 test gagal
  - **regresi baru: 0**; `test/plan-catalog.test.ts` gagal di keduanya (pre-existing).
- Dua regresi sempat muncul dan sudah diperbaiki:
  `class-routes-role-guard.test.ts` (18 test) + `jwtMultiRoleAuth.suspension.test.ts`
  + 3 test `school-live-regressions.test.ts` — semuanya 401 palsu karena pemeriksaan
  `sv` dijalankan pada row yang tidak membawa kolom itu. Setelah dijaga, semuanya
  hijau kembali.
- `eslint src/modules/auth src/common/middleware src/common/errors src/bootstrap/app.ts`
  → 6 error, **identik** dengan baseline `origin/dev` (semuanya pre-existing di file
  yang tidak saya ubah).

## Batas / non-scope

- Tidak menyentuh FE.
- **Belum di-deploy.** Perubahan di-commit di branch `wt/t_2cd6cd63` dan di-push
  sebagai `fix/t_2cd6cd63-auth-routes`; **tidak** di-push ke `dev`, karena push ke
  `dev` memicu workflow `deploy-backend.yml` = deploy produksi, dan itu butuh
  persetujuan owner. `api.lembar.web.id` masih 404 untuk kelima endpoint itu.
- Migrasi `0045` belum diterapkan ke DB live? Sudah — kolom `session_version` sudah
  ada di DB live (`integer NOT NULL DEFAULT 1`) dan kode baru membacanya dengan aman.

## Catatan kolaborasi (hotspot)

`~/Projects/Backend-Lembar` dipakai bersamaan oleh task ini dan `t_9d83cd2a`.
Percobaan pertama task ini menulis langsung ke checkout bersama itu, sehingga
`src/common/middleware/jwtMultiRoleAuth.ts`, `authenticateWithDb.ts`,
`JwtMultiRoleAuthService.ts`, `JwtAuthFlows.ts` dan
`src/infrastructure/database/migrations/meta/_journal.json` tercampur dua task.
Pekerjaan akhir dikerjakan ulang di worktree bersih `wt/` milik task ini. Sisa
perubahan belum di-commit di checkout bersama di-stash
(`git stash list` → `t_2cd6cd63+t_9d83cd2a mixed residue`), jadi checkout itu
kembali bersih dan aman untuk deploy berikutnya.

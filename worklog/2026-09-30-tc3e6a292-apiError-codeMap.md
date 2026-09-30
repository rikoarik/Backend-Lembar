# 2026-09-30 — BUG-20b lanjutan (kanban t_c3e6a292): password lemah → 500, bukan 400

**Task:** `t_c3e6a292` ([P1], assignee `lembar-backend`). Ditemukan saat verifikasi
live `t_9d83cd2a`.
**Repo:** `Backend-Lembar`. Branch kerja `wt/t_c3e6a292-codeMap`, di-base dari
`origin/dev` `79f32e0`.

## Gejala (repro ke produksi, SEBELUM perbaikan)

```
POST https://api.lembar.web.id/v1/auth/register
{"email":"b20b-probe-<ts>@example.test","password":"lemah","name":"Probe"}
-> 500 {"error":{"code":"INTERNAL_ERROR",
        "message":"Kata sandi minimal 12 karakter, berisi huruf besar, angka, dan simbol",
        "requestId":"req_tbUsOjVx2XH-Y65h","retryable":true}}
```

Saat audit, ketemu **kasus kedua yang belum dilaporkan**, juga 500:

```
POST /v1/auth/register {"username":"ab", ...}
-> 500 INTERNAL_ERROR "Username 3-24 karakter: huruf, angka, titik, atau underscore"
```

`retryable: true` di body itu penting: FE/BFF memperlakukan 5xx sebagai layak
ulang, jadi klien mengulang request yang **tidak akan pernah berhasil**.

## Akar masalah

`src/common/errors/apiError.ts` memetakan shorthand `code` → `StableErrorCode`
lewat `codeMap`, dengan fallback `codeMap[code] || 'INTERNAL_ERROR'`. Fallback
itu diam-diam mengubah kesalahan **input** jadi **500 retryable** untuk setiap
shorthand yang lupa didaftarkan.

Status sebelum patch ini: `password_policy` **sudah** punya mapping (masuk lewat
`3912a20`, task `t_2cd6cd63`) — itulah sebabnya `POST /v1/auth/register`
password lemah sudah 400 di produksi saat task ini mulai. Yang **belum**:
`invalid_username`, `invalid_phone`, `username_exists`, `phone_exists`,
`validation_error`, `conflict`, `not_found` — semuanya masih jatuh ke 500.
`invalid_username` saya buktikan live (di atas); sisanya ketemu dari
perbandingan grep `throwApiError('…')` di `src/` dengan isi `codeMap`.

Catatan riwayat: perbaikan menyeluruh untuk kelas bug ini sudah pernah
dikerjakan di branch `wt/p1-templates-codeMap` (commit `9fc7afc`, task
`t_b1a49359`) tetapi **tidak pernah di-merge ke dev** dan tidak ada di origin.
Perbaikan di task ini ditulis ulang dari `dev` supaya bisa mendarat, dan
mencakup seluruh shorthand yang benar-benar dipakai.

## Patch

- `src/common/errors/apiError.ts` — `codeMap` keluar dari body fungsi menjadi
  `SHORTHAND_ERROR_CODE_MAP` yang di-export, dan sekarang memuat **setiap**
  shorthand yang dipakai di `src/`:
  `validation_error`, `invalid_username`, `invalid_phone`, `username_exists`,
  `phone_exists`, `conflict`, `not_found` (plus `password_policy` yang sudah ada).
  Mapping: 400 untuk input salah, 409 untuk bentrok state, 404 untuk resource,
  401/403 auth, 429 rate limit, 500 hanya untuk kegagalan server asli.
- `src/bootstrap/errorHandlers.ts` (baru) — handler 404 + error handler bersama
  dipindah keluar dari `buildApp()` menjadi `registerErrorHandlers()` yang
  di-export, supaya test level-route bisa menguji envelope asli tanpa membangun
  seluruh aplikasi. `envelopeFor()` juga pindah ke sini. Perilaku identik.
- `src/bootstrap/app.ts` — memanggil `registerErrorHandlers(app)`; blok inline
  yang lama dihapus (81 baris berkurang).
- `test/common/apiError.test.ts` (baru) — assertion per-shorthand, plus penjaga
  yang **memindai `src/` dan gagal bila ada shorthand yang dipakai tanpa
  mapping**. Ini yang membuat kelas bug ini tidak bisa kembali diam-diam.
- `test/modules/auth/register-password-policy.test.ts` (baru) — HTTP-level:
  route asli + error handler asli; password lemah **wajib** 400
  `VALIDATION_FAILED`, `retryable: false`. Database double-nya melempar kalau
  jalur kebijakan password menyentuh persistence — jadi test juga membuktikan
  penolakan terjadi sebelum I/O.

## Bukti test menangkap bug (RED → GREEN)

Mapping `password_policy` dihapus sementara, lalu:

```
× returns 400 VALIDATION_FAILED (not 500) for a weak password
    AssertionError: expected 500 to be 400
× maps password_policy to VALIDATION_FAILED / 400 / not retryable
    AssertionError: expected 'INTERNAL_ERROR' to be 'VALIDATION_FAILED'
× maps every shorthand used in src/ ...
    + "password_policy (used in src/modules/auth/application/JwtAuthFlows.ts, ...)"
× never maps a client-error shorthand to a retryable 5xx code
    AssertionError: password_policy must not be a 5xx: expected 500 to be less than 500
Tests  6 failed | 6 passed (12)
```

Setelah mapping dikembalikan: `Test Files 2 passed (2) / Tests 12 passed (12)`.

## Gate

| Gate | Hasil |
|---|---|
| `tsc -p tsconfig.json --noEmit` | exit 0 |
| `tsc -p tsconfig.build.json` | exit 0 |
| `vitest run test/common/apiError.test.ts test/modules/auth/register-password-policy.test.ts` | 12/12 pass |
| `vitest run --no-file-parallelism` (full) | 1 failed, 832 passed, 92 skipped (925) |
| `eslint` (5 file yang disentuh) | 4 error, **identik** dengan baseline `origin/dev` |

Kegagalan full-suite itu `test/plan-catalog.test.ts:126` — **pre-existing**,
direproduksi di worktree bersih `t_c8fb4860` @ `97c72ce`
(`expected 149000 to be 49000`). Regresi baru: **0**.

Catatan: `test/smoke/worker.smoke.test.ts` sempat gagal karena `dist/` belum
dibangun di worktree; setelah `pnpm build` (exit 0) test itu lulus. Bukan
kegagalan kode.

## Deploy & verifikasi live

Merge `--no-ff` ke `dev`, push `79f32e0..6bc2388`. Workflow
`deploy-backend.yml` berjalan (checkout VPS pindah ke `6bc2388`; `pm2 lembar-api`
online, restart ke-63). `gh run list` tidak bisa dipakai untuk mengonfirmasi
status run dari sini (GitHub API TLS handshake timeout / EOF berulang), jadi
verifikasi dilakukan dari dua sisi: HEAD checkout deploy = `6bc2388`, dan hasil
HTTP di bawah.

`curl` ke **produksi** `https://api.lembar.web.id` setelah deploy:

```
CASE1 register weak password   400  VALIDATION_FAILED  retryable=false
      "Kata sandi minimal 12 karakter, berisi huruf besar, angka, dan simbol"
CASE2 register short username  400  VALIDATION_FAILED  retryable=false
      "Username 3-24 karakter: huruf, angka, titik, atau underscore"   <- 500 sebelum patch
CASE3 register invalid email   400  VALIDATION_FAILED  retryable=false
CASE4 register missing name    400  VALIDATION_FAILED  retryable=false
CONTROL valid register         201  (token + user)                      <- tidak rusak
```

requestId nyata: `req_ggimXIsAbZlkA8Fj` (CASE1), `req_LE1WsmSqHLKtN54T` (CASE2),
`req_ZBN27WPHiyGnS_g0` (CASE3), `req_db2XQoAKiepv8f_J` (CASE4).
Bukti mentah: `live-evidence-postfix.json`, `live-evidence-control.json` di
`/home/hermes/.hermes/profiles/lembar-backend/cache/scratch/tc3e6a292/`.

Verifikasi itu dijalankan pada build commit `6bc2388` (`pm2 lembar-api`
online). Worklog ini lalu di-push terpisah sebagai `550bbba`, dan
`git diff --stat 6bc2388 550bbba -- src/` **kosong** — jadi `src/` yang melayani
produksi sekarang identik dengan `src/` yang diuji. `/health` 200
(`uptimeSeconds: 134`). Pengulangan `curl` register setelahnya hanya menjawab
429 karena limiter register (5/jam/IP) sudah terpakai oleh probe di atas — bukan
kegagalan endpoint. Sebagai kontrol tambahan pada build yang sama, jalur lain
yang memakai modul codeMap yang sama juga sudah benar:
`POST /v1/auth/login {}` → 400 `VALIDATION_FAILED`, route tanpa auth → 401
`AUTH_REQUIRED`, route tidak dikenal → 404 `RESOURCE_NOT_FOUND`, semuanya
`retryable: false`.

Data uji dibersihkan: baris `c3e6a292-*`, `probe-*`, `b20b-*` dihapus dari
`jwt_users`, dan tenant yang ikut terbuat dihapus. Sisa: 0.

## Batas / non-scope

- Tidak menyentuh FE.
- Tidak mengubah OpenAPI — kontrak error (`code`/`retryable`) sudah dideklarasikan;
  yang berubah hanya mapping internal supaya sesuai kontrak.
- Tidak mengubah HTTP status untuk kasus yang memang 5xx
  (`workspace_creation_failed`, `user_creation_failed`) — tetap `INTERNAL_ERROR`
  + retryable, karena memang kegagalan server.
- `invalid_phone` belum bisa dibuktikan live: butuh `phone` yang setelah
  normalisasi (hanya digit) tersisa 1–7 digit, sementara validasi format jalan
  belakangan. Mapping-nya tetap ditambahkan (jelas 400 secara semantik) dan
  di-cover test unit. Jalur itu tidak bisa dijangkau dari luar dengan input wajar.
- Branch `wt/p1-templates-codeMap` (`9fc7afc`, task `t_b1a49359`) masih belum
  di-merge dan sekarang **sebagian besar sudah tercakup** oleh commit ini;
  sisanya (pemindahan handler) juga sudah dilakukan di sini.

## Hotspot

`src/common/errors/apiError.ts` disentuh bersamaan oleh `t_b1a49359`
(`wt/p1-templates-codeMap`, belum mendarat) dan task ini. Task ini yang mendarat
di dev; kalau `t_b1a49359` dilanjutkan, branch itu perlu di-rebase ke atas
`6bc2388` — perubahan `apiError.ts`-nya sudah tergantikan.

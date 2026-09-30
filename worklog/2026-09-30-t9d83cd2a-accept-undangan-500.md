# 2026-09-30 — BUG-20b (kanban t_9d83cd2a): accept undangan sekolah 500

**Task:** `t_9d83cd2a` ([P1], assignee `lembar-backend`) — follow-up temuan
FE-AUD-01-2026-09-30 BUG-20b.

**Repo:** `Backend-Lembar` @ `dev` `97c72ce` (perubahan belum di-commit, local-only).

## Gejala

```
POST https://api.lembar.web.id/v1/invitations/accept {"token":"9b9cf773…4c6a","password":"Aud01Inv123!"}
-> 500 {"error":{"code":"INTERNAL_ERROR",…}}
log: null value in column "name" of relation "jwt_users" violates not-null constraint
```

## Akar masalah — tiga, semuanya terpisah

1. **`jwt_users` di-INSERT tanpa kolom NOT NULL.** `PostgresSchoolStores.saveUser()`
   menulis `(id, email, password_hash, created_at)`, sedangkan `name`, `username`
   dan `roles` NOT NULL. Setiap accept untuk email baru → 500. (Ini yang
   dilaporkan tiket.)

2. **`accepted_by` FK menunjuk tabel yang salah.** `auth_school_invitations.accepted_by`
   (0006) mereferensikan `auth_accounts(id)`, tetapi akun yang dibuat lewat
   undangan hidup di `jwt_users` — satu-satunya tabel yang dipakai stack JWT yang
   aktif (`auth_accounts` menyimpan 342 baris legacy yang tidak disentuh endpoint
   mana pun). Setelah (1) diperbaiki, UPDATE yang membakar token ditolak:
   `violates foreign key constraint auth_school_invitations_accepted_by_auth_accounts_id_fk`
   → tetap 500. **Tidak dilaporkan di tiket**; ditemukan saat verifikasi live.

3. **Membership tidak pernah dibuat.** `saveMember()` hanya meng-`array_append`
   `roles`; `jwt_users.workspace_id` tidak pernah di-set. Karena
   `listMembers()` memfilter `WHERE workspace_id = $1`, anggota yang baru
   menerima undangan tidak akan pernah muncul di `/v1/school/members`.

Temuan tambahan: `password` sama sekali tidak divalidasi (accept menerima
password apa pun), sedangkan `/v1/auth/register` menuntut min 12 + huruf besar +
angka + simbol. Token juga tidak atomik: cek `state` dan UPDATE-nya terpisah,
jadi dua request bersamaan bisa sama-sama lolos.

## Patch

- `src/modules/auth/policy/passwordPolicy.ts` (baru) — satu sumber kebijakan
  password; `JwtMultiRoleAuthService` memakainya juga supaya register dan
  accept tidak bisa divergen.
- `src/modules/school/domain/inviteIdentity.ts` (baru) — turunan `name`
  (`budi.santoso@x.id` → `Budi Santoso`) dan `username` dari email, dengan pola
  yang sama seperti register (`^[a-zA-Z0-9_.]{3,24}$`).
- `src/modules/school/application/SchoolService.ts` — `acceptInvitation()`
  sekarang: cek kebijakan password lebih dulu, `markAccepted()` sebagai gerbang
  one-time (`WHERE state='pending'`), username unik dengan retry bernomor,
  dan seluruh mutasi dibungkus `transaction()`. Error dibedakan:
  `WeakPasswordError` / `ExpiredInvitationError` / `InvalidInvitationError`.
  Tambah `previewInvitation()` (BUG-20a).
- `src/modules/school/persistence/PostgresSchoolStores.ts` — `createUser()`
  mengisi `name`, `username`, `roles`; `saveMember()` ikut menulis
  `workspace_id`; `markAccepted()` mengisi `accepted_by` dan mengembalikan
  boolean; `transaction()` memakai satu client pool dengan `BEGIN/COMMIT/ROLLBACK`.
  `createUser()` menerjemahkan unique violation `jwt_users_username_unique`
  menjadi `UsernameTakenError` supaya bisa di-retry.
- `src/modules/school/adapters/http/schoolRoutes.ts` — pemetaan error
  (400 password / 404 tidak ada-atau-terpakai / **410 `INVITATION_EXPIRED`**),
  endpoint baru `GET /v1/invitations/preview`, dan `getRequestId()` memakai
  `req.id` sebagai ganti `req_unknown` (BUG-26).
- `src/infrastructure/database/migrations/0044_school_invitation_accepted_by_fk.sql`
  (baru) — `DROP CONSTRAINT IF EXISTS` FK `accepted_by`; idempoten, dengan
  catatan rollback.
- `test/modules/school/school-invitation-accept-bug20b.test.ts` (baru, 9 test) —
  fake store ikut menegakkan NOT NULL `name`/`username`/`roles` + pola username,
  jadi regresi ini tidak bisa kembali tanpa ketahuan.

## Verifikasi live

Build `tsc -p tsconfig.build.json` exit 0; `tsc -p tsconfig.json --noEmit` exit 0
(test ikut). Instance hasil build dijalankan di `127.0.0.1:4100` (bukan :4000 —
worker kanban lain sedang memakai checkout itu) dengan `DATABASE_URL` live, lalu
migrasi 0044 diterapkan ke DB live (idempoten, re-apply OK).

```
# CASE 1 — sukses (email baru)
sebelum : state=pending, accepted_by=NULL, jwt_users(email)=0
POST /v1/invitations/accept -> 200 {"data":{"userId":"710c8218-…","workspaceId":"105f43bf-…"}}
sesudah : state=accepted, accepted_by=710c8218-…
          jwt_users: username=b20b_1790742344, name="B20b 1790742344",
                     roles={teacher}, workspace_id=105f43bf-…,
                     password_hash=$2b$10$… (bcrypt, 60 char)

# CASE 2 — replay token yang sama
POST /v1/invitations/accept -> 404 RESOURCE_NOT_FOUND
                              "Undangan tidak ditemukan atau sudah digunakan."
jwt_users untuk email itu tetap 1 (tidak ada user kedua)

# CASE 3 — kedaluwarsa (pending, expires_at = now() - 1 day)
sebelum : state=pending
POST /v1/invitations/accept -> 410 INVITATION_EXPIRED "Undangan sudah kedaluwarsa."
sesudah : state tetap pending, accepted_by NULL, tidak ada user dibuat
pembanding token tak dikenal -> 404 RESOURCE_NOT_FOUND (pesan berbeda)

# paritas kebijakan password
password "lemah" -> 400 VALIDATION_FAILED
                    "Kata sandi minimal 12 karakter, berisi huruf besar, angka, dan simbol"
                    undangan tetap pending, token masih bisa dipakai

# preview (BUG-20a)
GET /v1/invitations/preview?token=<terpakai> -> 200 {"status":"used"}
GET /v1/invitations/preview?token=nope       -> 200 {"status":"invalid", email:null}
GET /v1/invitations/preview                  -> 400 VALIDATION_FAILED
```

## Gate

- `vitest run test/modules/school` → 10 file, **74/74 pass** (termasuk 9 test baru).
- `vitest run` (full) → **829 passed, 92 skipped, 1 failed**. Kegagalan tunggal
  `test/plan-catalog.test.ts:126` (harga katalog 149000 vs 49000) **pre-existing**:
  direproduksi di worktree bersih pada `dev` `97c72ce` tanpa perubahan apa pun.
- `eslint src/modules/school src/modules/auth/policy` → 10 error, semuanya di
  file yang tidak disentuh (mis. `libraryRoutes.ts`, `settingsRoutes.ts`).

## Batas / non-scope

- Tidak menyentuh FE. BFF FE masih memanggil `/v1/auth/invitations/consume`
  yang tidak ada di BE — itu tiket `t_2cd6cd63` (BUG-20a/BUG-18/21/22). Kontrak
  resmi BE untuk undangan sekolah: `POST /v1/invitations` →
  `GET /v1/invitations/preview` → `POST /v1/invitations/accept`.
- Perubahan belum di-commit: checkout `~/Projects/Backend-Lembar` sedang dipakai
  worker kanban lain (`t_2cd6cd63`) yang file-nya setengah jadi. Diff bersih
  disiapkan di worktree `t_9d83cd2a/wt`; menyentuh checkout itu akan mencampur
  dua task.

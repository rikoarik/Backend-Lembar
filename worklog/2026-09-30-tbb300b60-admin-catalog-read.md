# 2026-09-30 — BUG-11/12 (kanban t_bb300b60): modul admin katalog read + outcomes 500

**Task:** `t_bb300b60` ([P1], assignee `lembar-backend`) — follow-up temuan
FE-VER-02 F-1 (`docs/audit/E2E-VER-02-live-2026-09-30.md`).

**Commit:** BE `21d8734` + `b6e2398` on `dev` (unpushed, local-only contract).

## Gejala (dari laporan audit, akun `allroles@test.com`)

```
GET  /v1/admin/catalog/grades      -> 404 "Module admin belum di-register"
GET  /v1/admin/catalog/subjects    -> 404 (idem)
GET  /v1/admin/catalog/materials   -> 404 (idem)
GET  /v1/admin/catalog/outcomes?subjectId=official-... -> 500 INTERNAL_ERROR
POST /v1/admin/catalog/materials   -> 400 (tidak pernah 201)
```

Dampak: `/ops/catalog` → "Tambah Materi" → dropdown CP selalu kosong → form
tidak bisa disubmit.

## Akar masalah (tiga, semuanya terpisah)

1. **Route read admin tidak pernah didaftarkan.** `registerCatalogRoutes` hanya
   mendaftarkan tulis admin (`POST/PATCH/DELETE /v1/admin/catalog/...`). Keempat
   `GET` yang dibaca FE tidak ada di route table sama sekali, jadi jatuh ke
   `setNotFoundHandler` — pesan "Module admin belum di-register" itu berasal dari
   hint di `src/bootstrap/app.ts`, bukan dari modul admin. Terkonfirmasi lewat
   `app.printRoutes()` sebelum perubahan: hanya `POST`/`PATCH`/`DELETE` yang
   muncul.

2. **`GET /v1/admin/catalog/outcomes` → 500.** Handler mengirim `subjectId`
   mentah ke kolom `uuid`:
   ```sql
   SELECT ... FROM outcomes WHERE subject_id = $1
   ```
   Untuk slug resmi (`official-subject-sd-mi-a-...`, bukan uuid) Postgres
   melempar `22P02 invalid input syntax for type uuid` → tidak tertangani →
   `INTERNAL_ERROR`. Ini persis `subjectId` yang dikirim FE dari dropdown mapel.

3. **Tidak ada jalur untuk menautkan materi ke CP resmi.** `materials` punya FK
   `NOT NULL` ke `outcomes/subjects/phases/grades/curricula`, sedangkan CP
   katalog resmi hidup di snapshot JSON tanpa baris DB. Jadi `POST` dengan
   `outcomeId = <officialSubjectId>-cp` (satu-satunya nilai yang ditawarkan
   dropdown) tidak punya parent untuk ditunjuk.

Saat memperbaiki (3) muncul bug keempat yang selama ini laten karena cabang
publish tidak pernah tercapai: `jsonb_build_object($2, ...)` gagal dengan
`could not determine data type of parameter $2` — argumen variadik `any` butuh
cast eksplisit.

## Patch

`src/modules/catalog/adapters/http/catalogRoutes.ts`:

- Daftarkan `GET /v1/admin/catalog/{grades,subjects,materials,outcomes}` di
  bawah `adminGuard` (superadmin).
- `listOutcomeOptions()`: hanya kirim ke kolom `uuid` bila `isUuid(subjectId)`;
  slug resmi dijawab dari snapshot (`officialOutcomeOption`).
- `POST /v1/admin/catalog/materials`: `outcomeId` uuid → jalur DB seperti
  semula; `outcomeId` `<officialSubjectId>-cp` → materialisasi rantai resmi
  dulu, baru insert.
- Cabang publish: cast eksplisit (`$n::uuid`, `$n::text`), dan insert +
  `material_versions` + update `published_version` dibungkus satu transaksi
  supaya publish gagal tidak meninggalkan materi setengah jadi.
- `listGradesFor()` / `listSubjectsFor()` diekstrak dan dipakai bersama route
  publik + admin supaya kedua permukaan tidak bisa divergen.
- Aktor audit dibaca dari `request.jwtUser` (sebelumnya `request.user` yang
  selalu `undefined`, jadi **semua** baris `admin_audit` katalog tercatat
  `actor_id='unknown'`).

`src/modules/catalog/officialCatalog.ts`: `resolveOfficialSubject()` — resolusi
slug → record snapshot + grade + `cpId`, dengan `cpLabel` yang tidak pernah
kosong (42 record snapshot tidak punya `description`).

`src/modules/catalog/persistence/officialMaterialization.ts` (baru):
`materializeOfficialOutcome()` / `findMaterializedOfficialChain()`. Rantai
curriculum → grade → phase → subject → outcome di-`INSERT ... ON CONFLICT`
memakai kode deterministik (`official-grade-*`, `official-phase-*`,
`official-subject-*`, outcome `CP`) sehingga idempoten, `published_version = 1`.
Tenant pemilik = workspace caller; bila caller tidak punya workspace, dipakai
tenant bersama `official-kemendikdasmen`. Sengaja tanpa transaksi eksplisit:
setiap upsert atomik & idempoten, jadi kegagalan parsial hanya meninggalkan baris
referensi — bukan materi setengah tertaut.

`test/modules/catalog/catalog-admin-read.test.ts` (baru, 11 test): route read
admin terdaftar, gating 401/403, validasi query 400, snapshot resmi jalan tanpa
DB, dan resolusi CP (`officialOutcomeOption`, `isUuid`, label tidak kosong).

## Bukti live

Build baru di-deploy ke `lembar-api` (pm2 restart) lalu diverifikasi via
`127.0.0.1:4000` dengan token superadmin `allroles@test.com`.

### DoD 1 — read admin 200 (sebelumnya 404)

```
GET /v1/admin/catalog/grades                                  -> 200  rows=28
GET /v1/admin/catalog/subjects?gradeId=official-grade-sd-mi-1 -> 200  rows=23
GET /v1/admin/catalog/materials?gradeId=..&subjectId=..&curriculumVersionId=.. -> 200
```

### DoD 2 — outcomes 200 (sebelumnya 500)

```
GET /v1/admin/catalog/outcomes?subjectId=official-subject-sd-mi-a-muatan-lokal-lain-lain
  -> 200 {"data":[{"id":"official-subject-sd-mi-a-muatan-lokal-lain-lain-cp",
                   "label":"CP — CP Muatan Lokal Lain-lain"}]}

GET /v1/admin/catalog/outcomes?subjectId=a135e8bd-d85a-451a-9e2e-8a744bdebc4b  (uuid tenant)
  -> 200 {"data":[{"id":"812e03f0-cd2b-43f2-ad26-dccb7ad232da",
                   "label":"O-1790718942 — CP uji t0728adef"}]}
```

### DoD 3 — POST 201 + baris tercipta, diverifikasi lewat GET

```
POST /v1/admin/catalog/materials
  {"outcomeId":"official-subject-sd-mi-a-muatan-lokal-lain-lain-cp",
   "code":"BUG11-FINAL","kind":"lesson","title":"Verifikasi final BUG-11/12",
   "sourceRights":"license:internal","publish":true}
  -> 201 {"data":{"id":"4039a008-ab21-46e6-9d7b-6501896a3656",
                  "title":"Verifikasi final BUG-11/12","published":true}}
```

Baris DB (workspace nyata `allroles@test.com`, bukan tenant bersama):

```
 id                                   | code        | title                     | published_version | current_version | tenant                | versions
 4039a008-ab21-46e6-9d7b-6501896a3656 | BUG11-FINAL | Verifikasi final BUG-11/12| 1                 | 1               | All Roles's Workspace | 1
```

Verifikasi lewat GET admin (materi terbaca kembali, `outcomeId` terisi):

```
GET /v1/admin/catalog/materials?gradeId=559cd429-..&subjectId=ef621566-..&curriculumVersionId=..
  -> {"data":[{"id":"4039a008-ab21-46e6-9d7b-6501896a3656",
               "label":"Verifikasi final BUG-11/12",
               "outcomeId":"4f0476c8-9c9e-4340-8151-69c7e71b43a2",
               "status":"active"}]}
```

### Regresi

- Route publik `GET /v1/catalog/{curricula,grades,phases,subjects,materials}`
  semuanya tetap **200**.
- Gating: token `teacher` → `403` pada kedua route admin katalog.
- Data uji (`BUG11-*`, `PROBE-*`, tenant `official-kemendikdasmen`, baris
  `OFFICIAL-CP`) sudah dihapus kembali; cek sisa = 0.

## Tindak lanjut `b6e2398` — materialisasi merusak picker (ditemukan saat re-verifikasi)

Re-verifikasi end-to-end pada build yang sama menemukan tiga cacat yang semuanya
bermula dari materialisasi rantai resmi (ditulis ke tenant pemanggil):

1. **Grade ganda.** Setelah satu materi dibuat, `GET /v1/admin/catalog/grades`
   menampilkan setiap grade resmi **dua kali** (snapshot + baris mirror
   `official-grade-*` di tenant). Baris referensi (`code` berawalan `official-`)
   kini difilter dari daftar milik tenant.
2. **Materi baru tak terlihat.** Form mengirim slug (`subjectId=official-…`,
   `gradeId=official-…`) sedangkan materi tersimpan di uuid hasil materialisasi,
   jadi query tidak cocok dan jatuh ke snapshot. Query slug sekarang diresolusi
   dulu ke uuid rantai (`findMaterializedOfficialChain`).
3. **Topik snapshot hilang.** Begitu cabang DB cocok, cabang resmi tidak lagi
   dipakai sehingga seluruh topik snapshot lenyap. Topik tidak punya baris DB
   sama sekali, jadi kini ditambahkan ke hasil cabang DB
   (`materializedOfficialTopicMaterials()`).

Bukti live (build dengan `b6e2398`, `lembar-api` di-restart, `127.0.0.1:4000`):

```
### DoD1 — admin read 200 (was 404)
GET /v1/admin/catalog/grades                                 -> 200  rows=28
GET /v1/admin/catalog/subjects?gradeId=official-grade-sd-mi-1 -> 200  rows=23
GET /v1/admin/catalog/materials?gradeId=..&subjectId=..&curriculumVersionId=.. -> 200  rows=7

### DoD2 — outcomes 200 (was 500 INTERNAL_ERROR)
GET /v1/admin/catalog/outcomes?subjectId=official-subject-sd-mi-a-muatan-lokal-lain-lain
  -> 200 {"data":[{"id":"c7fd65b9-705e-4483-8995-d8902d08eadb",
                   "label":"CP — CP Muatan Lokal Lain-lain"}]}

### DoD3 — POST 201 + baris tercipta, diverifikasi lewat GET
POST /v1/admin/catalog/materials {"outcomeId":"official-subject-sd-mi-a-muatan-lokal-lain-lain-cp",
  "code":"DOD3-091818","kind":"lesson","title":"Verifikasi BUG-11/12 091818",
  "sourceRights":"license:internal","publish":true}
  -> 201 {"data":{"id":"fe57d4e2-0ad9-4a99-8c90-97076c2a22d2","title":"Verifikasi BUG-11/12 091818","published":true}}
DB: fe57d4e2-0ad9-4a99-8c90-97076c2a22d2 | DOD3-091818 | published_version=1 | current_version=1
    | tenant=e96e9772-d9e4-4cdf-a960-8c82b68bc1c6   material_versions=1
    | admin_audit.actor_id=249c9731-e224-46c6-8051-102b2b957dd3  (bukan 'unknown')
GET /v1/admin/catalog/materials?... -> 200, baris baru terlihat, plus 2 topik snapshot tetap ada

### Regresi
grade picker entries=28, duplikat 'Kelas 1 SD/MI — Fase A' = 1
public /v1/catalog/grades -> 200 ; /v1/catalog/curricula -> 200 ; anon admin -> 401
```

Bukti yang sama juga diambil dari luar host melalui `https://api.lembar.web.id`
(`grades` 200, `subjects` 200, `materials` 200, `outcomes` 200, `POST` 201),
sesuai jalur yang dipakai FE.

## Gates

- `pnpm typecheck` exit 0; `pnpm build` exit 0.
- `vitest run test/modules/catalog/` **25/25 hijau** (4 berkas; 2 test baru
  mengunci regresi grade ganda + retensi topik).
- `eslint src/modules/catalog/ test/modules/catalog/` bersih (exit 0).
- Suite penuh: 818 passed / 1 failed / 92 skipped. Satu kegagalan,
  `plan-catalog.test.ts > pro plan has a finite tokenMonthlyLimit fallback`
  (`expected 149000 to be 49000`), **tidak tersentuh** oleh perubahan ini —
  `git diff origin/dev..dev -- src/modules/plans test/plan-catalog.test.ts`
  kosong, dan test itu terakhir diubah di `5df5ec0` (2026-08-23). Sudah ada
  sebelum task ini (attempt sebelumnya mencatat `plan-catalog` sebagai gagal).

## Catatan

- Tidak ada deploy produksi. `lembar-api` di-restart dengan build yang memuat
  perubahan agar bukti live di atas bisa diambil.
- Commit unpushed (`dev`, local-only contract) — menunggu keputusan publish.
- Data uji `DOD3-*` / `FINAL-*` / `VERIFY-*` / `LIVE*` / `SIDE-*` dan rantai
  resmi hasil materialisasi sudah dihapus kembali setelah verifikasi
  (`probe_materials=0`, `official_rows=0`, `materials_total=25` — sama seperti
  sebelum task).

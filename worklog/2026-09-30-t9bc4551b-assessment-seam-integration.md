# 2026-09-30 — kanban t_9bc4551b: integration coverage untuk assessment seam

**Task:** `t_9bc4551b` (assignee `lembar-backend`) — "Add integration coverage for
the assessment seam". Cover: API + worker memakai Postgres yang sama saat
`DATABASE_URL` diset, fallback in-memory saat tidak diset, dan roundtrip
generation/import; pakai harness test yang ada; assert read-after-write lintas
seam.

**Branch:** `wt/add-integration-coverage-for-the-asses` (worktree
`.worktrees/t_9bc4551b`, base `origin/dev` @ `79f32e0`).

## Apa yang ditambahkan

`test/modules/assessments/assessment-seam.integration.test.ts` (baru, 7 test).

Tiga kelompok:

### 1. Postgres seam — API + worker satu database (`describe.skipIf(!DATABASE_URL)`)

- **worker menulis, API proses terpisah membaca.** Worker-side handler dirakit
  persis seperti `WorkerService.setupHandlers` (`PostgresAssessmentsStore` +
  `PostgresQuestionGenerationStore` + `PostgresQuestionReviewStore` +
  `QuestionReviewService`) lalu `handle()` untuk 3 blueprint item. Setelah itu:
  hitung baris `generated_questions`/`reviewed_questions` lewat pool langsung
  (read-after-write tanpa handle worker), lalu `buildApp()` **proses baru**
  membaca lewat HTTP `GET /v1/workspaces/:ws/assessments/:id` (status `ready`)
  dan `GET .../versions/:versionId/questions` (3 baris, `pending`, urut 0–2).
  `originalQuestionId` tiap reviewed row dicocokkan dengan id
  `generated_questions` yang benar-benar tersimpan.
- **satu import pass per baris persisted + tahan replay.** Setelah generation
  sukses: `question_audit_log` action `created` = 2, `reviewed_questions` = 2,
  `generated_questions` = 2. Job yang sama dijalankan ulang (redelivery queue)
  tidak menambah baris apa pun.
- **queue store lintas proses.** Dua panggilan `createSharedQueueStore(process.env)`
  terpisah (tidak berbagi objek; keduanya `PostgresQueueStore`) — job yang
  di-insert lewat store "API" di-claim lewat store "worker".

### 2. Fallback in-memory tanpa `DATABASE_URL` (selalu jalan)

- `createSharedQueueStore` resolve ke `InMemoryQueueStore`.
- Roundtrip create + list assessment lewat HTTP tanpa database.
- **Fallback bersifat process-local**: app kedua tidak melihat baris app
  pertama — divergensi yang memang jadi alasan seam Postgres ada.
- Roundtrip generation/import worker terhadap store in-memory (2 soal → 2
  reviewed, `pending`).

### 3. Fixture deterministik

`registerMockFixture('question-generation-v1', …)` dipakai supaya generation
lewat `MockAiAdapter` menghasilkan JSON schema-valid (fixture default
`rawJsonFromSeed` sengaja tidak valid terhadap `QUESTION_OUTPUT_SCHEMA`, jadi
tanpa fixture generation selalu `SCHEMA_REPAIR_EXHAUSTED`).

## Blocker harness yang diperbaiki

`pnpm test:db` — satu-satunya jalur resmi untuk suite DB-gated menurut
`docs/backend/TEST-POSTGRES.md` — **gagal total pada database kosong**:
`scripts/prepare-test-db.mjs` apply semua migrasi berurutan, dan
`0019_indonesian_education_training.sql` mendeklarasikan
`id_grades.phase CHECK (phase IN ('A','B','C','D'))` sementara seed-nya sendiri
menulis fase `E`/`F` (baris 10–12). Hasil: `23514 new row for relation
"id_grades" violates check constraint "id_grades_phase_check"` di baris ke-27
dari 48, dan tabel assessment belum pernah terbentuk. Tidak ada test DB-gated
yang bisa jalan.

Perbaikan (2 baris):

- `src/infrastructure/database/migrations/0019_indonesian_education_training.sql`:
  constraint jadi `IN ('A','B','C','D','E','F')`, konsisten dengan seed di file
  yang sama dan dengan widening di `0022_fix_id_grades_phase_constraint.sql`.
  Tidak mengubah database yang sudah ada: Drizzle migrator apply by journal
  timestamp, bukan content hash.
- `docs/backend/TEST-POSTGRES.md`: bagian "Current migration blocker" (yang
  menyebut kegagalan lain, `marketing_content.revision already exists`, dan
  sudah tidak akurat) diganti "Migration history" yang mencatat cacat ini.

## Bukti

Semua perintah dijalankan di worktree, `JWT_SECRET='assessment-seam-integration-secret'`.

```
# harness resmi sekarang provisioning bersih
$ DATABASE_URL=postgres://lembar_test:***@127.0.0.1:55432/lembar_test \
  node scripts/prepare-test-db.mjs
Prepared isolated test database: 48 SQL migrations applied, 14 drizzle migration hashes recorded.
   (sebelum perbaikan: 23514 id_grades_phase_check, 48 migrasi tidak selesai)

# suite baru, DB aktif
$ DATABASE_URL=… pnpm exec vitest run test/modules/assessments/assessment-seam.integration.test.ts
Test Files  1 passed (1)
     Tests  7 passed (7)

# suite baru, tanpa DB (fallback path)
$ env -u DATABASE_URL pnpm exec vitest run test/modules/assessments/assessment-seam.integration.test.ts
Test Files  1 passed (1)
     Tests  4 passed | 3 skipped (7)

# suite DB-gated yang sudah ada, DB aktif (regresi harness)
$ DATABASE_URL=… pnpm exec vitest run \
    test/modules/assessments/assessment-seam.integration.test.ts \
    test/modules/assessments/postgres-assessment-flow.test.ts \
    test/infrastructure/database.test.ts
Test Files  3 passed (3)
     Tests  11 passed (11)

# suite penuh, DB aktif
$ DATABASE_URL=… DATABASE_REQUIRED=true pnpm exec vitest run
Test Files  3 failed | 130 passed (133)
     Tests  10 failed | 910 passed (920)

# suite penuh tanpa perubahan ini (git stash --include-untracked), DB aktif
$ git stash push --include-untracked -m seam-test-wip
$ DATABASE_URL=… pnpm exec vitest run \
    test/modules/notifications/adapter.test.ts \
    test/modules/uploads/body-limit.test.ts \
    test/modules/uploads/intake-content.test.ts \
    test/plan-catalog.test.ts
Test Files  4 failed (4)
     Tests  10 failed | 29 passed (39)
$ git stash pop

# gates
$ pnpm build            -> exit 0 (tsc -p tsconfig.build.json)
$ pnpm exec tsc -p tsconfig.json --noEmit -> exit 0
$ pnpm exec eslint test/modules/assessments/assessment-seam.integration.test.ts -> exit 0
$ pnpm exec prettier --check test/modules/assessments/assessment-seam.integration.test.ts docs/backend/TEST-POSTGRES.md
All matched files use Prettier code style!
```

Isolasi data: setelah run, `tenants slug like 'seam-%'` = 0, `assessments` = 0,
`generated_questions` = 0, `reviewed_questions` = 0, `spike_jobs` = 0.

## 10 kegagalan suite penuh = pre-existing (dibuktikan)

`notifications/adapter.test.ts` (1), `uploads/body-limit.test.ts` (4),
`uploads/intake-content.test.ts` (5) — semuanya gagal dengan set yang sama
**tanpa** perubahan ini (lihat `git stash` di atas). `plan-catalog.test.ts`
juga sudah tercatat gagal pre-existing di t_c8fb4860 dan worklog t_bb300b60.
Tidak ada test yang berubah dari hijau → merah karena perubahan ini.

## Scope & batasan

- Tidak ada perubahan produksi, tidak ada deploy, tidak ada perubahan schema
  yang berlaku ke database existing (hanya file migrasi historis + doc).
- Tidak ada perubahan `src/` selain constraint `0019`. Seam Postgres-nya sendiri
  sudah ter-wire dari task-task sebelumnya; task ini menambah coverage-nya.
- `test:db` sekarang **bisa** provisioning, tapi suite DB-gated lain masih punya
  cacat migrasi historisnya sendiri; task ini hanya memperbaiki blocker yang
  menghalangi suite seam berjalan.
- Hotspot yang belum ditutup (di luar scope, sudah dilaporkan t_c8fb4860):
  `generated_questions.workspace_id` masih `text` sementara tabel assessment
  lain `uuid`; migrasi `0023_generated_questions.sql` juga belum terdaftar di
  `meta/_journal.json`. Cleanup di test ini sengaja membandingkan
  `::text` supaya benar pada kedua bentuk.

---

## Follow-up — landing di `dev` (kanban `t_53da17cf`)

Worklog ini ikut ter-cherry-pick bersama perbaikannya. Yang berubah saat landing:

- **`4dc5c26` di-cherry-pick apa adanya** ke `wt/t53-prepare-test-db-harness`
  (base `origin/dev` @ `2f894b9`) → `4112761`. Tidak ada re-derive.
- **3 assertion stale diperbaiki.** Suite ini menandatangani token dengan konstanta
  lokal `JWT_SECRET='assessment-seam-integration-secret'`, tapi `buildApp()`
  membaca secret dari `process.env.JWT_SECRET`
  (`src/bootstrap/app.ts:496` → `assessmentPrivateAuth`), dengan fallback
  `'dev-secret-change-in-production'`. Jadi `401` yang muncul adalah **signature
  mismatch**, bukan auth hardening yang menolak token sah — komentar lama
  ("dev's auth hardening correctly returns 401") salah membaca gejalanya.
  Perbaikan: satu baris `process.env['JWT_SECRET'] = JWT_SECRET;` di header test,
  supaya token ditandatangani dengan secret yang benar-benar dipakai app. Guard
  auth **tidak disentuh**; 401 untuk token tak sah tetap berlaku.
- **Bug asli `4dc5c26` (1 assertion, `detail` GET 200) ternyata satu akar yang
  sama** dengan 2 kegagalan fallback: semuanya 401 dari signature mismatch.

Bukti setelah landing:

```
$ node scripts/prepare-test-db.mjs
Prepared isolated test database: 48 SQL migrations applied, 14 drizzle migration hashes recorded.
PREPARE_EXIT=0

$ DATABASE_URL=… npx vitest run test/modules/assessments/
Test Files  28 passed (28)
     Tests  238 passed (238)

$ DATABASE_URL=… DATABASE_REQUIRED=true npx vitest run
Test Files  5 failed | 130 passed (135)
     Tests  11 failed | 921 passed (932)
   → 11 kegagalan identik dengan `git stash` + rerun pada dev murni:
     plan-catalog (1), smoke/worker (1), notifications/adapter (1),
     uploads/body-limit (4), uploads/intake-content (4). Semuanya pre-existing.

$ npx tsc -p tsconfig.json --noEmit   -> exit 0
$ npx tsc -p tsconfig.build.json      -> exit 0
$ npx eslint test/modules/assessments/assessment-seam.integration.test.ts -> exit 0
$ npx prettier --check <4 file>       -> All matched files use Prettier code style!
```

Tidak ada perubahan live data: `0019` adalah file migrasi historis, Drizzle
apply by journal timestamp, jadi tidak ada DDL yang jalan ke database existing.

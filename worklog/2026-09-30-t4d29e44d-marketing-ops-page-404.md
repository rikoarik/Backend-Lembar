# 2026-09-30 — P1 t_4d29e44d: `GET /v1/ops/marketing/pages/{slug}` 404 untuk home/harga/untuk-sekolah

**Task:** `t_4d29e44d` ([P1], assignee `lembar-backend`) — follow-up FE-VER-02 **F-2**
dari `t_9ae972fd` (laporan `docs/audit/E2E-VER-02-live-2026-09-30.md`, commit `5bd0e05`).

**Commit:** BE `9306d09` on `dev` (unpushed, local-only contract).

## Symptom

Live `dev` @ `7337ecf`:

```
GET /v1/ops/marketing/pages          -> 200 {"data":[]}
GET /v1/ops/marketing/pages/home     -> 404 Konten marketing tidak ditemukan.
GET /v1/ops/marketing/pages/harga    -> 404 (idem)
```

Akibatnya `/ops/content` menampilkan panel Beranda/Harga/Untuk sekolah kosong
("Revisi —"), sementara pengumuman global (`GET/PUT /v1/admin/announcement`) 200.

## Diagnosis — ini masalah **data**, bukan route yang hilang

Handler-nya sudah ada dan sudah benar:

- `src/modules/marketing/adapters/http/opsRoutes.ts` mendaftarkan
  `GET /v1/ops/marketing/pages/:slug`, memvalidasi slug terhadap
  `MARKETING_PAGE_SLUGS = ['home','untuk-sekolah','harga']`, lalu memanggil
  `MarketingOpsService.getPageForOps()`.
- `getPageForOps()` melakukan `select ... where slug = $1 and kind = 'page'`; bila
  tidak ada baris ia melempar `notFound()` → 404 dengan pesan itu persis.
- `test/modules/marketing/ops.test.ts` (14 test) sudah lulus, termasuk
  "reads marketing page authoring state" → 200.
- `dist/` yang disajikan pm2 memuat route ini (6 kemunculan
  `ops/marketing/pages/:slug`), jadi build live memang versi terbaru.

Jadi 404 berasal dari DB. Bukti:

```
$ psql -c "select kind,slug,state,published_version from marketing_content;"
 kind   |   slug     |  state    | published_version
--------+------------+-----------+-------------------
 global | __global__ | published |                 1
(1 row)
```

Hanya baris `__global__`. Tiga halaman publik **tidak pernah di-seed**:

- `scripts/marketing-published-seed.mjs` memang mendefinisikan dokumen
  `home`/`untuk-sekolah`/`harga` (dan diuji oleh
  `test/modules/marketing/defaultPublishedMarketing.test.ts`), tetapi
  `scripts/seed-marketing-global.mjs` adalah langkah **manual lokal** yang tidak
  pernah dijalankan terhadap database ini, dan tidak ada migration yang
  menanamnya.
- Karena `listPages()` memfilter `kind = 'page'`, daftar pun kosong → `{"data":[]}`.
- `__global__` sendiri balas **400** `VALIDATION_FAILED` di
  `GET /v1/public/marketing/global` (payload live-nya tidak sesuai skema —
  `navigation[0].title` 215 karakter > `MAX_ITEM_TITLE` 200, `ctas` 5 item >
  `MAX_CTAS` 4). Itu temuan terpisah, tidak menghalangi F-2.

## Patch

`src/infrastructure/database/migrations/0043_marketing_page_seed.sql` (baru) —
seed idempoten untuk tiga halaman publik, memakai payload yang sudah
disetujui/diuji dari `MARKETING_PUBLISHED_SEED_DOCUMENTS`:

- Pola sama dengan migration seed lain di repo (`0024`, `0026`, `0030`):
  `BEGIN; SELECT pg_advisory_xact_lock(430043); ... COMMIT;`.
- Tiap insert dijaga `WHERE NOT EXISTS (kind='page' AND slug=... AND locale='id-ID')`
  → re-apply = no-op, tidak pernah menimpa halaman yang sudah diedit superadmin.
- Baris ditanam sebagai **draft** (`state='draft'`, `published_version = NULL`,
  `draft_payload` terisi). Konsol authoring bisa langsung membaca/menyunting/
  menerbitkan; halaman marketing publik tetap memakai fallback JSX sampai
  superadmin menekan "Terbitkan" — jadi migration ini tidak bisa mengubah live site.
- `migrations/meta/_journal.json` mendapat entri `idx 15` / `0043_marketing_page_seed`.

`test/modules/marketing/ops-page-seed.test.ts` (baru, 5 test, DB-gated):

1. re-apply no-op (tidak duplikat, `revision` tetap 1);
2. `GET /v1/ops/marketing/pages` mengembalikan ketiga slug;
3. `GET /v1/ops/marketing/pages/{slug}` → 200 + draft ber-skema untuk tiap slug,
   `publishedVersion = null`;
4. route publik tetap 404 selama belum diterbitkan;
5. setelah `PUT .../draft` (revisi 2), re-apply migration tidak me-reset revisi.

## Verifikasi

**Migration diuji dua arah lebih dulu.**

- Salinan database live (`lembar_scratch`, dari `pg_dump`): apply 2× →
  `4 rows` (global + 3 page draft), idempoten, lalu scratch di-drop.
- DB live: `psql -f 0043_marketing_page_seed.sql` → `INSERT 0 1` ×3 + `COMMIT`.

```
 kind   |     slug      | locale |  state  | revision | published_version | has_draft
--------+---------------+--------+---------+----------+-------------------+-----------
 global | __global__    | id-ID  | published |    1   |        1          | f
 page   | harga         | id-ID  | draft     |    1   |                   | t
 page   | home          | id-ID  | draft     |    1   |                   | t
 page   | untuk-sekolah | id-ID  | draft     |    1   |                   | t
(4 rows)
```

**curl (superadmin JWT, build live `7337ecf`)** — sebelum/sesudah:

| endpoint | sebelum | sesudah |
| --- | --- | --- |
| `GET /v1/ops/marketing/pages` | 200 `{"data":[]}` | 200, 3 item |
| `GET /v1/ops/marketing/pages/home` | **404** | **200** `{"summary":{"slug":"home","state":"draft","revision":1,...}}` |
| `GET /v1/ops/marketing/pages/harga` | **404** | **200** |
| `GET /v1/ops/marketing/pages/untuk-sekolah` | **404** | **200** |
| `GET /v1/public/marketing/pages/home` | 404 | 404 (belum dipublish — disengaja) |

Diverifikasi di tiga jalur: `http://127.0.0.1:4000`, `https://api.lembar.web.id`
(bypass BFF), dan `https://app.lembar.web.id` (BFF) — semuanya 200.

Alur authoring end-to-end ikut dicek lewat API live:

```
PUT  /v1/ops/marketing/pages/home/draft  (if-match: 1)  -> 200, revision 2
GET  /v1/ops/marketing/pages/home/preview              -> 200, draft terbaru, Cache-Control: no-store
PUT  /v1/ops/marketing/pages/home/draft  (if-match: 1)  -> 409 CMS_REVISION_CONFLICT
```

Setelah probe, `draft_payload` `home` dikembalikan ke payload seed semula
(`revision = 1`) supaya tidak menyisakan draft uji.

**Test:** `npx vitest run test/modules/marketing/` → **5 file, 30 test lulus**
(termasuk 5 test baru).

## Catatan untuk task lain (bukan scope F-2)

1. **`pnpm test:db` masih rusak.** `scripts/prepare-test-db.mjs` menerapkan file
   `.sql` urut nama; `0019_indonesian_education_training.sql` men-seed baris SMA
   dengan `phase` `E`/`F` sementara CHECK yang dideklarasikan di file yang sama
   hanya mengizinkan `A-D`, dan `0022_fix_id_grades_phase_constraint.sql` (yang
   melebarkannya ke `A-F`) baru berjalan sesudahnya. Jadi prepare gagal:
   `new row for relation "id_grades" violates check constraint "id_grades_phase_check"`.
   Ini defect urutan migration BUG-20 yang sedang ditangani di
   `p_d2b76342/t_1d511328` (`migrations.order.json`). Untuk verifikasi task ini
   saya memakai prep scratch yang hanya menulis ulang CHECK inline 0019 menjadi
   `A-F` (identik dengan constraint yang dipasang 0022) — 47/47 migration, dan
   skema akhirnya sama persis dengan produksi. `docs/backend/TEST-POSTGRES.md`
   masih menyebut blocker lama (`marketing_content.revision`), yang sudah tidak
   akurat lagi setelah `0009_superb_epoch`/`0003_marketing_cms` di-`IF NOT EXISTS`.
2. **`GET /v1/public/marketing/global` → 400.** Payload `__global__` yang live
   tidak lolos validator terbit: `navigation[0].title` 215 karakter (batas 200),
   `ctas` 5 item (batas `MAX_CTAS` 4), dan `cta` di dalam `footer`/`navigation`
   tidak ada. Ini masalah data + temuan tersendiri; tidak menghalangi F-2 karena
   konsol ops membaca `draft_payload`, bukan versi terbit.

## Hasil suite penuh

`npx vitest run` (DATABASE_URL ke test DB terisolasi): **891 lulus / 10 gagal**.
Kesepuluh kegagalan direproduksi identik pada `dev` HEAD `91291d4` tanpa commit
ini (worktree `/tmp/t4d29-base` dihapus setelah probe) — pre-existing dan tidak
berkaitan: `test/plan-catalog.test.ts` (1), `test/modules/notifications/adapter.test.ts` (1),
`test/modules/uploads/body-limit.test.ts` (4), `test/modules/uploads/intake-content.test.ts` (4).

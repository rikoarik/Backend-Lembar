# 2026-09-30 — P3 t_0728adef: `GET /v1/catalog/materials` belum ekspos `outcomeId`

**Task:** `t_0728adef` ([P3], assignee `lembar-backend`) — follow-up dari
`t_4f661c67` (fix `blueprint_items.outcome_id` dari `materialIds`).

**Commit:** BE `ca5c5e4` on `dev` (unpushed, local-only contract);
FE `7a832d4` on `p_d2b76342/t_0728adef-p3-catalog-materials-belum-ekspos-outcom`.

## Symptom

`GET /v1/catalog/materials` mengembalikan `{ id, label, status }` saja di kedua
cabangnya. Cabang resmi (snapshot Kemendikdasmen) punya id deterministik
(`<subjectId>-cp` / `<subjectId>-topic-N`) sehingga BFF bisa menurunkan outcome
dari bentuk id. Cabang DB (tabel `materials` milik tenant) memakai uuid acak —
tidak ada yang bisa diturunkan, jadi `blueprint_items.outcome_id` kembali NULL
begitu materi tenant benar-benar dipublikasikan.

Laten saat ditemukan: seluruh baris `materials` masih `published_version IS NULL`
sehingga cabang DB selalu kosong dan live memakai katalog resmi.

## Patch

BE (`ca5c5e4`):

- `src/modules/catalog/adapters/http/catalogRoutes.ts` — cabang DB memilih
  `materials.outcome_id` dan mengembalikannya sebagai `outcomeId` (null bila
  kolomnya kosong). Tipe `CatalogMaterialOption` ditambahkan.
- `src/modules/catalog/officialCatalog.ts` — `listOfficialMaterials()` juga
  menyertakan `outcomeId` (`<subjectId>-cp`) untuk baris CP maupun tiap topik.
- `contracts/openapi.yaml` — schema aditif `CatalogMaterialOption`
  (`outcomeId` optional + nullable) dipakai oleh `/v1/catalog/materials`;
  checksum di-refresh.
- `test/modules/catalog/catalog-materials-outcome.test.ts` (baru, 4 test) —
  cabang DB (uuid outcome, outcome null, isolasi tenant) + cabang resmi.

FE (`7a832d4`):

- `src/features/generate/materialOutcomes.ts` — `materialOutcomeMap()` membangun
  lookup `materialId -> outcomeId` dari payload katalog; baris tanpa `outcomeId`
  yang layak dilewati supaya respons parsial turun ke fallback, bukan
  menutupinya. `resolveOutcomeIdsForMaterials()` membaca lookup itu lebih dulu,
  baru menurunkan dari bentuk id katalog resmi (fallback dipertahankan).
- `app/v1/generate/submit/route.ts` — mengambil katalog sekali (best-effort,
  hanya bila `materialIds` ada) dan menyerahkan map ke `buildBlueprintItems()`;
  kegagalan katalog tidak memblokir generate yang masih bisa diatribusikan
  fallback.
- `src/lib/api/schema.d.ts` + `docs/contracts/openapi-baseline.yaml` —
  `CatalogMaterialOption`; `catalogService.listMaterials` mengembalikannya.
  Tidak ada DTO tulisan tangan yang diduplikasi.
- `app/v1/generate/submit/route.test.ts` — 4 kasus baru: uuid DB dari
  `outcomeId`, null bila kedua sumber gagal, fallback saat katalog 500, cabang
  resmi tetap menurunkan.
- `app/v1/generate/submit/route.db-outcome.live.test.ts` (baru, skip default).

## Bukti live

Materi tenant dipublikasikan lewat API kurikulum (workspace
`a01b25da-6d0c-4bc5-98d3-9fb2a28aa641`):

```
POST /v1/curriculum/materials  -> id c7d68e99-0ef3-4c0e-bbaf-1955fbc93ab0
POST /v1/curriculum/materials/c7d68e99-.../publish -> 200
GET  /v1/catalog/materials?gradeId=641232b8-...&subjectId=a135e8bd-...&curriculumVersionId=e7bd2f40-...
  {"data":[{"id":"c7d68e99-0ef3-4c0e-bbaf-1955fbc93ab0",
            "label":"Materi tenant t0728adef",
            "outcomeId":"812e03f0-cd2b-43f2-ad26-dccb7ad232da",
            "status":"active"}]}
```

Generate lewat BFF asli (`app/v1/generate/submit/route.ts` -> `backendFetch` asli
-> `127.0.0.1:4000`, sesi guru asli), `materialIds = [c7d68e99-...]`:

```
assessment_version_id = 9d8b16a7-38b9-4d08-8a78-d34f6370b246
select sequence, outcome_id from blueprint_items where assessment_version_id='9d8b16a7-...';
  0 | 812e03f0-cd2b-43f2-ad26-dccb7ad232da
  1 | 812e03f0-cd2b-43f2-ad26-dccb7ad232da
  2 | 812e03f0-cd2b-43f2-ad26-dccb7ad232da
  3 | 812e03f0-cd2b-43f2-ad26-dccb7ad232da      -> 4/4 baris, 0 NULL

spike_jobs 8d624b49-33eb-477c-bf48-b89e2c6ae52f: status succeeded, 1 attempt
generated_questions: 3 baris untuk version tersebut
```

Sebelum perubahan, `outcome_id` untuk uuid materi ini selalu NULL (derivasi
bentuk id tidak mengenali uuid).

## Gates

- BE: `pnpm typecheck` exit 0; `pnpm build` exit 0; `pnpm openapi:validate` ok;
  `pnpm openapi:breaking` tidak melaporkan perubahan breaking untuk endpoint ini
  (daftar breaking yang tersisa identik dengan hasil `git stash` — sudah ada
  sebelum perubahan); `pnpm vitest run test/modules/catalog/` 13/13 hijau.
- FE: `pnpm typecheck` exit 0; eslint bersih di berkas tersentuh; prettier bersih;
  `vitest run app/v1/generate/submit/route.test.ts
  src/features/generate/__tests__/material-outcomes.test.ts` 18/18 hijau.
- Full suite FE di worktree ini merah (249 gagal) **sebelum maupun sesudah**
  perubahan — `git stash -u` menghasilkan jumlah kegagalan yang identik; suite
  yang sama hijau di worktree utama. Kegagalan berasal dari resolusi
  `@testing-library/jest-dom` di environment worktree, bukan dari perubahan ini.

## Re-verifikasi (run kanban t_0728adef, 2026-09-30 06:2x)

Live proof diulang dari nol di run ini, bukan dikutip dari run sebelumnya:

- `GET /v1/catalog/materials` (live, 127.0.0.1:4000, sesi guru, materi DB yang
  dipublikasikan) mengembalikan `outcomeId` = `812e03f0-...` untuk material
  `c7d68e99-...`.
- Live test `app/v1/generate/submit/route.db-outcome.live.test.ts` dijalankan
  dengan `LEMBAR_LIVE_PROOF=1` → **PASS 1/1** setelah commit `ad24ee4`
  menambahkan `// @vitest-environment node`. Sebelum itu test gagal HANYA pada
  langkah terakhir (`import('node:fs')` untuk menulis `/tmp/t0728.live.json`)
  karena environment jsdom mengeksternalisasi `node:fs`; asersi live
  (katalog → submit → payload) sudah lolos dan baris Postgres sudah tertulis.
- `blueprint_items` untuk version hasil run ini
  `e1aa3598-469d-45a9-9efb-c6e147daf7b3` → 4/4 baris `outcome_id =
  812e03f0-cd2b-43f2-ad26-dccb7ad232da` (`outcome_id is not null` true untuk
  keempatnya).
- BE `test/modules/catalog/` 13/13 hijau; `pnpm typecheck` exit 0; eslint bersih
  di berkas tersentuh. FE `route.test.ts` 7/7 + `material-outcomes.test.ts` 11/11
  hijau; `pnpm typecheck` exit 0; eslint & prettier bersih di berkas tersentuh.
- `pnpm lint` di FE gagal karena PATH me-resolve ESLint global 10.8.0 (dari
  `~/.hermes`) alih-alih v9.18.0 milik repo — masalah environment, bukan
  perubahan; memakai `node_modules/.bin/eslint` repo hasilnya bersih.
- 249 kegagalan suite FE penuh sudah dikonfirmasi ada di `dev` (root `React.act
  is not a function`, mismatch React 19 vs testing-library) — bukan dari task ini.

## Notes

- Tidak ada deploy produksi. Proses `lembar-api` di-restart dengan build yang
  memuat perubahan BE agar bukti live di atas bisa diambil.
